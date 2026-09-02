import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import type { DatabaseConfig } from "./config.js";
import { ProductionDatabase } from "./database.js";
import { configureEmbeddingSpace } from "./embedding-space.js";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_VERSION,
  embeddingSpace,
  type EmbeddingSpace,
} from "./embeddings.js";

interface AppliedMigration {
  version: string;
  checksum: string;
}

export const postgresMigrationDirectory = fileURLToPath(
  new URL("../../migrations/postgres", import.meta.url),
);

export async function migratePostgres(
  config: DatabaseConfig,
  directory = postgresMigrationDirectory,
  space: EmbeddingSpace = {
    model: DEFAULT_EMBEDDING_MODEL,
    version: DEFAULT_EMBEDDING_VERSION,
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
  },
): Promise<string[]> {
  const targetSpace = embeddingSpace(space);
  const database = new ProductionDatabase(config);
  try {
    const applied = await database.withSystemTransaction(async (client) => {
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
        if (version === "002") {
          await assertEmbeddingMigrationCompatible(client, targetSpace);
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
    await configureEmbeddingSpace(database, targetSpace);
    return applied;
  } finally {
    await database.close();
  }
}

async function assertEmbeddingMigrationCompatible(
  client: PoolClient,
  requested: EmbeddingSpace,
): Promise<void> {
  const table = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('agentic.assertions') IS NOT NULL AS exists",
  );
  if (table.rows[0]?.exists !== true) {
    return;
  }
  await client.query(
    "LOCK TABLE agentic.assertions IN ACCESS EXCLUSIVE MODE",
  );
  const zeroVectors = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM agentic.assertions
       WHERE vector_norm(embedding) = 0
     ) AS exists`,
  );
  if (zeroVectors.rows[0]?.exists === true) {
    throw new Error(
      "Existing assertions contain zero embeddings and require re-embedding before migration",
    );
  }
  const spaces = await client.query<{
    model: string;
    version: string;
    dimensions: number;
  }>(
    `SELECT
       embedding_model AS model,
       embedding_version AS version,
       vector_dims(embedding) AS dimensions
     FROM agentic.assertions
     GROUP BY embedding_model, embedding_version, vector_dims(embedding)
     LIMIT 2`,
  );
  if (spaces.rows.length > 1) {
    throw new Error(
      "Existing assertions contain multiple embedding spaces and require an explicit re-embedding migration",
    );
  }
  const existing = spaces.rows[0];
  if (
    existing &&
    (existing.model !== requested.model ||
      existing.version !== requested.version ||
      existing.dimensions !== requested.dimensions)
  ) {
    throw new Error(
      `Requested embedding space ${requested.model}/${requested.version}/${requested.dimensions} does not match existing assertions ${existing.model}/${existing.version}/${existing.dimensions}`,
    );
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
       WHERE version = '002'
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
