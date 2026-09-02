import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { schemaSql } from "./schema.js";

export type SqlValue =
  | null
  | number
  | bigint
  | string
  | Uint8Array;

export type SqlRow = Record<string, SqlValue>;

export class SqliteStore {
  private readonly database: DatabaseSync;
  private transactionDepth = 0;

  public constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.database.exec(schemaSql);
    const idempotencyColumns = this.database
      .prepare("PRAGMA table_info(idempotency_results)")
      .all() as Array<{ name: string }>;
    if (!idempotencyColumns.some((column) => column.name === "request_hash")) {
      this.database.exec(
        "ALTER TABLE idempotency_results ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''",
      );
    }
    this.ensureColumn(
      "machine_instances",
      "terminal",
      "ALTER TABLE machine_instances ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1))",
    );
    this.database.exec(
      `UPDATE machine_instances
       SET terminal = 1
       WHERE machine_type = 'retail_order'
         AND state IN ('confirmed', 'cancelled', 'failed')`,
    );
    this.ensureColumn(
      "effect_intents",
      "outcome_handler",
      "ALTER TABLE effect_intents ADD COLUMN outcome_handler TEXT NOT NULL DEFAULT 'retail_order_payment' CHECK (outcome_handler IN ('retail_order_payment', 'none'))",
    );
    this.ensureColumn(
      "effect_intents",
      "status_url",
      "ALTER TABLE effect_intents ADD COLUMN status_url TEXT",
    );
    this.ensureColumn(
      "effect_intents",
      "decision_assertion_id",
      "ALTER TABLE effect_intents ADD COLUMN decision_assertion_id TEXT",
    );
    this.ensureColumn(
      "effect_intents",
      "policy_assertion_id",
      "ALTER TABLE effect_intents ADD COLUMN policy_assertion_id TEXT",
    );
    this.ensureEffectIntentForeignKeys();
    this.initializeLogicalClock();
  }

  public run(sql: string, ...params: SqlValue[]): number {
    const result = this.database.prepare(sql).run(...params);
    return Number(result.changes);
  }

  public get<T extends SqlRow>(
    sql: string,
    ...params: SqlValue[]
  ): T | undefined {
    return this.database.prepare(sql).get(...params) as T | undefined;
  }

  public all<T extends SqlRow>(sql: string, ...params: SqlValue[]): T[] {
    return this.database.prepare(sql).all(...params) as T[];
  }

  public transaction<T>(operation: () => T): T {
    const level = this.transactionDepth;
    const savepoint = `agentic_data_${level}`;
    this.transactionDepth += 1;

    try {
      this.database.exec(
        level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`,
      );
      const result = operation();
      this.database.exec(level === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      if (level === 0) {
        this.database.exec("ROLLBACK");
      } else {
        this.database.exec(`ROLLBACK TO ${savepoint}`);
        this.database.exec(`RELEASE ${savepoint}`);
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  public readQuery(sql: string): SqlRow[] {
    const trimmed = sql.trim();
    const withoutTrailingSemicolon = trimmed.endsWith(";")
      ? trimmed.slice(0, -1).trim()
      : trimmed;
    if (withoutTrailingSemicolon.includes(";")) {
      throw new Error("Only one read-only SQL statement is allowed");
    }
    if (
      !/^(select|explain)\b/i.test(withoutTrailingSemicolon) &&
      !/^pragma\s+(table_info|index_list|foreign_key_list)\b/i.test(
        withoutTrailingSemicolon,
      )
    ) {
      throw new Error("Only SELECT, EXPLAIN, and schema PRAGMAs are allowed");
    }
    return this.database.prepare(withoutTrailingSemicolon).all() as SqlRow[];
  }

  public allocateTimestamp(candidateMilliseconds: number): string {
    if (!Number.isFinite(candidateMilliseconds)) {
      throw new Error("Clock returned an invalid timestamp");
    }
    return this.transaction(() => {
      const row = this.database
        .prepare("SELECT last_millis FROM logical_clock WHERE id = 1")
        .get() as { last_millis: number };
      const milliseconds = Math.max(
        Math.trunc(candidateMilliseconds),
        Number(row.last_millis) + 1,
      );
      this.database
        .prepare("UPDATE logical_clock SET last_millis = ? WHERE id = 1")
        .run(milliseconds);
      return new Date(milliseconds).toISOString();
    });
  }

  public readTimestamp(candidateMilliseconds: number): string {
    if (!Number.isFinite(candidateMilliseconds)) {
      throw new Error("Clock returned an invalid timestamp");
    }
    const row = this.database
      .prepare("SELECT last_millis FROM logical_clock WHERE id = 1")
      .get() as { last_millis: number };
    return new Date(
      Math.max(Math.trunc(candidateMilliseconds), Number(row.last_millis)),
    ).toISOString();
  }

  public close(): void {
    this.database.close();
  }

  private ensureColumn(
    table: string,
    column: string,
    statement: string,
  ): void {
    const columns = this.database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      this.database.exec(statement);
    }
  }

  private ensureEffectIntentForeignKeys(): void {
    const foreignKeys = this.database
      .prepare("PRAGMA foreign_key_list(effect_intents)")
      .all() as Array<{ table: string }>;
    const assertionReferences = foreignKeys.filter(
      (foreignKey) => foreignKey.table === "assertions",
    ).length;
    if (
      foreignKeys.some(
        (foreignKey) => foreignKey.table === "machine_history",
      ) &&
      assertionReferences >= 2
    ) {
      return;
    }

    const invalid = this.database
      .prepare(
        `SELECT effect.effect_id
         FROM effect_intents effect
         LEFT JOIN machine_history history
           ON history.tenant_id = effect.tenant_id
          AND history.instance_id = effect.instance_id
          AND history.revision = effect.originating_revision
         LEFT JOIN assertions decision
           ON decision.tenant_id = effect.tenant_id
          AND decision.assertion_id = effect.decision_assertion_id
         LEFT JOIN assertions policy
           ON policy.tenant_id = effect.tenant_id
          AND policy.assertion_id = effect.policy_assertion_id
         WHERE history.instance_id IS NULL
            OR (
              effect.decision_assertion_id IS NOT NULL
              AND decision.assertion_id IS NULL
            )
            OR (
              effect.policy_assertion_id IS NOT NULL
              AND policy.assertion_id IS NULL
            )
         LIMIT 1`,
      )
      .get();
    if (invalid) {
      throw new Error(
        "Existing effect intents violate generic agency foreign keys",
      );
    }

    this.database.exec("PRAGMA foreign_keys = OFF");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        DROP TABLE IF EXISTS effect_intents_rebuild;
        CREATE TABLE effect_intents_rebuild (
          tenant_id TEXT NOT NULL,
          effect_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          originating_revision INTEGER NOT NULL,
          effect_name TEXT NOT NULL,
          effect_type TEXT NOT NULL,
          outcome_handler TEXT NOT NULL DEFAULT 'retail_order_payment' CHECK (
            outcome_handler IN ('retail_order_payment', 'none')
          ),
          target TEXT NOT NULL,
          status_url TEXT,
          request_json TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          decision_assertion_id TEXT,
          policy_assertion_id TEXT,
          status TEXT NOT NULL CHECK (
            status IN ('planned', 'unknown', 'succeeded', 'failed', 'cancelled')
          ),
          attempt_count INTEGER NOT NULL,
          outcome_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, effect_id),
          UNIQUE (
            tenant_id,
            instance_id,
            originating_revision,
            effect_name
          ),
          FOREIGN KEY (tenant_id, instance_id)
            REFERENCES machine_instances (tenant_id, instance_id),
          FOREIGN KEY (tenant_id, instance_id, originating_revision)
            REFERENCES machine_history (tenant_id, instance_id, revision),
          FOREIGN KEY (tenant_id, decision_assertion_id)
            REFERENCES assertions (tenant_id, assertion_id),
          FOREIGN KEY (tenant_id, policy_assertion_id)
            REFERENCES assertions (tenant_id, assertion_id)
        ) STRICT;
        INSERT INTO effect_intents_rebuild (
          tenant_id, effect_id, instance_id, originating_revision,
          effect_name, effect_type, outcome_handler, target, status_url,
          request_json, idempotency_key, decision_assertion_id,
          policy_assertion_id, status, attempt_count, outcome_json,
          created_at, updated_at
        )
        SELECT
          tenant_id, effect_id, instance_id, originating_revision,
          effect_name, effect_type, outcome_handler, target, status_url,
          request_json, idempotency_key, decision_assertion_id,
          policy_assertion_id, status, attempt_count, outcome_json,
          created_at, updated_at
        FROM effect_intents;
        DROP TABLE effect_intents;
        ALTER TABLE effect_intents_rebuild RENAME TO effect_intents;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }
    const violations = this.database
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (violations.length > 0) {
      throw new Error("SQLite foreign key validation failed after upgrade");
    }
  }

  private initializeLogicalClock(): void {
    const row = this.database
      .prepare(
        `SELECT MAX(timestamp_value) AS max_time
         FROM (
           SELECT system_from AS timestamp_value FROM assertions
           UNION ALL SELECT system_to FROM assertions WHERE system_to IS NOT NULL
           UNION ALL SELECT updated_at FROM machine_instances
           UNION ALL SELECT updated_at FROM timers
           UNION ALL SELECT updated_at FROM effect_intents
           UNION ALL SELECT created_at FROM execution_receipts
           UNION ALL SELECT created_at FROM idempotency_results
         )`,
      )
      .get() as { max_time: string | null };
    if (row.max_time === null) {
      return;
    }
    const milliseconds = Date.parse(row.max_time);
    if (!Number.isNaN(milliseconds)) {
      this.database
        .prepare(
          `UPDATE logical_clock
           SET last_millis = MAX(last_millis, ?)
           WHERE id = 1`,
        )
        .run(milliseconds);
    }
  }
}
