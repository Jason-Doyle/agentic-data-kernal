import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import type { DatabaseConfig } from "./config.js";
import { ProductionDatabase } from "./database.js";

interface AppliedMigration {
  version: string;
  checksum: string;
}

export async function migratePostgres(
  config: DatabaseConfig,
  directory = join(process.cwd(), "migrations", "postgres"),
): Promise<string[]> {
  const database = new ProductionDatabase(config);
  try {
    return await database.withSystemTransaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('agentic-data-migrations'))",
      );
      await ensureMigrationTable(client);
      const applied = await appliedMigrations(client);
      const files = (await readdir(directory))
        .filter((name) => /^\d+_.+\.sql$/.test(name))
        .sort();
      const newlyApplied: string[] = [];

      for (const file of files) {
        const version = file.split("_", 1)[0] ?? file;
        const source = await readFile(join(directory, file), "utf8");
        const checksum = createHash("sha256").update(source).digest("hex");
        const existing = applied.get(version);
        if (existing) {
          if (existing !== checksum) {
            throw new Error(
              `Migration ${version} checksum changed after application`,
            );
          }
          continue;
        }
        await client.query(source);
        await client.query(
          `INSERT INTO agentic.schema_migrations (
             version, file_name, checksum, applied_at
           ) VALUES ($1, $2, $3, clock_timestamp())`,
          [version, file, checksum],
        );
        newlyApplied.push(file);
      }
      return newlyApplied;
    });
  } finally {
    await database.close();
  }
}

export async function migrationStatus(
  config: DatabaseConfig,
): Promise<AppliedMigration[]> {
  const database = new ProductionDatabase(config);
  try {
    await database.query("CREATE SCHEMA IF NOT EXISTS agentic");
    await database.query(
      `CREATE TABLE IF NOT EXISTS agentic.schema_migrations (
         version TEXT PRIMARY KEY,
         file_name TEXT NOT NULL,
         checksum TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL
       )`,
    );
    const result = await database.query<AppliedMigration>(
      `SELECT version, checksum
       FROM agentic.schema_migrations
       ORDER BY version`,
    );
    return result.rows;
  } finally {
    await database.close();
  }
}

export async function assertMigrationsApplied(
  database: ProductionDatabase,
): Promise<void> {
  const result = await database.query<{ applied: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM agentic.schema_migrations
       WHERE version = '001'
     ) AS applied`,
  );
  if (result.rows[0]?.applied !== true) {
    throw new Error("Required PostgreSQL migrations are not applied");
  }
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query("CREATE SCHEMA IF NOT EXISTS agentic");
  await client.query(
    `CREATE TABLE IF NOT EXISTS agentic.schema_migrations (
       version TEXT PRIMARY KEY,
       file_name TEXT NOT NULL,
       checksum TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL
     )`,
  );
}

async function appliedMigrations(
  client: PoolClient,
): Promise<Map<string, string>> {
  const result = await client.query<AppliedMigration>(
    "SELECT version, checksum FROM agentic.schema_migrations",
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}
