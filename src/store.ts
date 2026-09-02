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
