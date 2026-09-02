import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import type { DatabaseConfig } from "./config.js";

export interface TenantContext {
  tenantId: string;
  principalId: string;
  keyId: string;
  purpose: string;
  scopes: Set<string>;
}

export class ProductionDatabase {
  public readonly pool: Pool;

  public constructor(private readonly config: DatabaseConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolSize,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "agentic-data-kernel",
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
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
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
    });
  }

  public async withTenantWriteTransaction<T>(
    context: TenantContext,
    operation: (client: PoolClient) => Promise<T>,
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
    });
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

export class MaintenanceModeError extends Error {
  public constructor(public readonly owner: string) {
    super(`Writes are paused for ${owner}`);
    this.name = "MaintenanceModeError";
  }
}
