import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { checkServerIdentity } from "node:tls";
import type { DatabaseConfig } from "./config.js";

export interface TenantContext {
  tenantId: string;
  principalId: string;
  keyId: string;
  purpose: string;
  scopes: Set<string>;
}

export type TransactionIsolation = "READ COMMITTED" | "REPEATABLE READ";

export class ProductionDatabase {
  public readonly pool: Pool;

  public constructor(private readonly config: DatabaseConfig) {
    const connectionString = validatedConnectionString(
      config.databaseUrl,
    );
    const databaseHostname = databaseHostnameFor(connectionString);
    this.pool = new Pool({
      connectionString,
      max: config.databasePoolSize,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: config.statementTimeoutMs,
      query_timeout: config.statementTimeoutMs + 1_000,
      application_name: "agentic-data-kernel",
      ssl: config.databaseSsl
        ? {
            rejectUnauthorized: true,
            ...(config.databaseCaCertificate
              ? { ca: config.databaseCaCertificate }
              : {}),
            checkServerIdentity: (_hostname, certificate) =>
              checkServerIdentity(databaseHostname, certificate),
          }
        : false,
      sslnegotiation: "postgres",
    });
  }

  public async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values);
  }

  public async withSystemTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    isolation: TransactionIsolation = "READ COMMITTED",
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (isolation === "REPEATABLE READ") {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
        );
      }
      await client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [String(this.config.statementTimeoutMs)],
      );
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async withSystemWriteTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.withSystemTransaction(async (client) => {
      await this.assertWritesAllowed(client);
      return operation(client);
    });
  }

  public async withTenantTransaction<T>(
    context: TenantContext,
    operation: (client: PoolClient) => Promise<T>,
    isolation: TransactionIsolation = "READ COMMITTED",
  ): Promise<T> {
    return this.withSystemTransaction(async (client) => {
      await client.query(
        `SELECT
           set_config('app.tenant_id', $1, true),
           set_config('app.principal_id', $2, true),
           set_config('app.key_id', $3, true),
           set_config('app.purpose', $4, true)`,
        [
          context.tenantId,
          context.principalId,
          context.keyId,
          context.purpose,
        ],
      );
      return operation(client);
    }, isolation);
  }

  public async withTenantWriteTransaction<T>(
    context: TenantContext,
    operation: (client: PoolClient) => Promise<T>,
    isolation: TransactionIsolation = "READ COMMITTED",
  ): Promise<T> {
    return this.withSystemTransaction(async (client) => {
      await client.query(
        `SELECT
           set_config('app.tenant_id', $1, true),
           set_config('app.principal_id', $2, true),
           set_config('app.key_id', $3, true),
           set_config('app.purpose', $4, true)`,
        [
          context.tenantId,
          context.principalId,
          context.keyId,
          context.purpose,
        ],
      );
      await this.assertWritesAllowed(client);
      return operation(client);
    }, isolation);
  }

  public async health(): Promise<boolean> {
    const result = await this.pool.query<{ healthy: number }>(
      "SELECT 1 AS healthy",
    );
    return result.rows[0]?.healthy === 1;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  private async assertWritesAllowed(client: PoolClient): Promise<void> {
    const result = await client.query<{
      active: boolean;
      owner: string | null;
    }>(
      `SELECT active, owner
       FROM agentic.maintenance_state
       WHERE singleton = TRUE
       FOR SHARE`,
    );
    if (result.rows[0]?.active) {
      throw new MaintenanceModeError(
        result.rows[0].owner ?? "maintenance",
      );
    }
  }
}

function validatedConnectionString(value: string): string {
  const url = new URL(value);
  const forbidden = new Set([
    "ssl",
    "sslcert",
    "sslkey",
    "sslmode",
    "sslnegotiation",
    "sslrootcert",
    "uselibpqcompat",
  ]);
  const conflicts = [...url.searchParams.keys()].filter((name) =>
    forbidden.has(name.toLowerCase()),
  );
  if (conflicts.length > 0) {
    throw new Error(
      "DATABASE_URL must not contain SSL query parameters; use DATABASE_SSL and DATABASE_CA_CERT_BASE64",
    );
  }
  return value;
}

function databaseHostnameFor(connectionString: string): string {
  const hostname = new URL(connectionString).hostname;
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export class MaintenanceModeError extends Error {
  public constructor(public readonly owner: string) {
    super(`Writes are paused for ${owner}`);
    this.name = "MaintenanceModeError";
  }
}
