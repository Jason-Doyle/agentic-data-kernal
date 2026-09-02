import type { PoolClient, QueryResultRow } from "pg";
import type { ProductionDatabase } from "./database.js";
import {
  embeddingSpace,
  type EmbeddingSpace,
} from "./embeddings.js";

const minimumPgvectorVersion = [0, 8, 0] as const;

interface EmbeddingConfigurationRow extends QueryResultRow {
  model: string;
  version: string;
  dimensions: number;
}

interface ExtensionRow extends QueryResultRow {
  extversion: string;
}

interface IndexRow extends QueryResultRow {
  indisvalid: boolean;
}

export interface EmbeddingSpaceStatus {
  configured: boolean;
  indexed: boolean;
  ready: boolean;
  pgvectorVersion: string | null;
  actual: EmbeddingSpace | null;
}

export async function configureEmbeddingSpace(
  database: ProductionDatabase,
  requested: EmbeddingSpace,
): Promise<void> {
  const target = embeddingSpace(requested);
  const client = await database.pool.connect();
  let transactionOpen = false;
  let lockHeld = false;
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('agentic-data-embedding-space'))",
    );
    lockHeld = true;
    await assertPgvectorVersion(client);
    await client.query("BEGIN");
    transactionOpen = true;
    const configured = await readConfiguration(client, true);
    if (configured && !spacesEqual(configured, target)) {
      const countResult = await client.query<{ count: string }>(
        "SELECT count(*)::TEXT AS count FROM agentic.assertions",
      );
      if (Number(countResult.rows[0]?.count ?? "0") > 0) {
        throw new Error(
          "Embedding model, version, or dimensions cannot change while assertions exist; re-embed or remove existing assertions first",
        );
      }
      await client.query(
        `UPDATE agentic.embedding_configuration
         SET model = $1, version = $2, dimensions = $3,
             configured_at = clock_timestamp()
         WHERE singleton = TRUE`,
        [target.model, target.version, target.dimensions],
      );
    } else if (!configured) {
      await client.query(
        `INSERT INTO agentic.embedding_configuration (
           singleton, model, version, dimensions, configured_at
         ) VALUES (TRUE, $1, $2, $3, clock_timestamp())`,
        [target.model, target.version, target.dimensions],
      );
    }
    await client.query("COMMIT");
    transactionOpen = false;
    await ensureEmbeddingIndex(client, target.dimensions);
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    if (lockHeld) {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext('agentic-data-embedding-space'))",
      );
    }
    client.release();
  }
}

export async function embeddingSpaceStatus(
  database: ProductionDatabase,
  requested: EmbeddingSpace,
): Promise<EmbeddingSpaceStatus> {
  const target = embeddingSpace(requested);
  const extension = await database.query<ExtensionRow>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  );
  const configured = await database.query<EmbeddingConfigurationRow>(
    `SELECT model, version, dimensions
     FROM agentic.embedding_configuration
     WHERE singleton = TRUE`,
  );
  const actual = configured.rows[0] ?? null;
  const index = await database.query<IndexRow>(
    `SELECT index.indisvalid
     FROM pg_index index
     WHERE index.indexrelid = to_regclass($1)`,
    [`agentic.${embeddingIndexName(target.dimensions)}`],
  );
  const configuredMatches = actual !== null && spacesEqual(actual, target);
  const indexed = index.rows[0]?.indisvalid === true;
  const pgvectorVersion = extension.rows[0]?.extversion ?? null;
  return {
    configured: configuredMatches,
    indexed,
    ready:
      configuredMatches &&
      indexed &&
      pgvectorVersion !== null &&
      versionAtLeast(pgvectorVersion, minimumPgvectorVersion),
    pgvectorVersion,
    actual,
  };
}

export async function assertEmbeddingSpaceConfigured(
  database: ProductionDatabase,
  requested: EmbeddingSpace,
): Promise<void> {
  const target = embeddingSpace(requested);
  const status = await embeddingSpaceStatus(database, target);
  if (
    !status.pgvectorVersion ||
    !versionAtLeast(status.pgvectorVersion, minimumPgvectorVersion)
  ) {
    throw new Error(
      `pgvector 0.8.0 or newer is required; found ${status.pgvectorVersion ?? "none"}`,
    );
  }
  if (!status.configured) {
    const actual = status.actual
      ? `${status.actual.model}/${status.actual.version}/${status.actual.dimensions}`
      : "none";
    throw new Error(
      `Configured embedding space ${target.model}/${target.version}/${target.dimensions} does not match database embedding space ${actual}; run migrations with the intended embedding settings`,
    );
  }
  if (!status.indexed) {
    throw new Error(
      `Embedding index ${embeddingIndexName(target.dimensions)} is unavailable; run migrations`,
    );
  }
}

export function embeddingIndexName(dimensions: number): string {
  const target = embeddingSpace({
    model: "index",
    version: "1",
    dimensions,
  });
  return `assertions_embedding_hnsw_${target.dimensions}`;
}

async function readConfiguration(
  client: PoolClient,
  forUpdate: boolean,
): Promise<EmbeddingConfigurationRow | null> {
  const result = await client.query<EmbeddingConfigurationRow>(
    `SELECT model, version, dimensions
     FROM agentic.embedding_configuration
     WHERE singleton = TRUE
     ${forUpdate ? "FOR UPDATE" : ""}`,
  );
  return result.rows[0] ?? null;
}

async function assertPgvectorVersion(client: PoolClient): Promise<void> {
  const result = await client.query<ExtensionRow>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  );
  const version = result.rows[0]?.extversion;
  if (!version || !versionAtLeast(version, minimumPgvectorVersion)) {
    throw new Error(
      `pgvector 0.8.0 or newer is required; found ${version ?? "none"}`,
    );
  }
}

async function ensureEmbeddingIndex(
  client: PoolClient,
  dimensions: number,
): Promise<void> {
  const indexName = embeddingIndexName(dimensions);
  const existing = await client.query<IndexRow>(
    `SELECT index.indisvalid
     FROM pg_index index
     WHERE index.indexrelid = to_regclass($1)`,
    [`agentic.${indexName}`],
  );
  if (existing.rows[0]?.indisvalid === true) {
    return;
  }
  await client.query("SET statement_timeout = 0");
  try {
    if (existing.rows[0]) {
      await client.query(`DROP INDEX CONCURRENTLY agentic.${indexName}`);
    }
    await client.query(
      `CREATE INDEX CONCURRENTLY ${indexName}
       ON agentic.assertions
       USING HNSW ((embedding::vector(${dimensions})) vector_cosine_ops)
       WHERE embedding_dimensions = ${dimensions}`,
    );
  } finally {
    await client.query("RESET statement_timeout");
  }
}

function spacesEqual(
  left: EmbeddingSpace,
  right: EmbeddingSpace,
): boolean {
  return (
    left.model === right.model &&
    left.version === right.version &&
    left.dimensions === right.dimensions
  );
}

function versionAtLeast(
  version: string,
  minimum: readonly [number, number, number],
): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return false;
  }
  const parts = match.slice(1).map((part) => Number(part));
  for (let index = 0; index < minimum.length; index += 1) {
    const actual = parts[index] ?? 0;
    const required = minimum[index] ?? 0;
    if (actual > required) {
      return true;
    }
    if (actual < required) {
      return false;
    }
  }
  return true;
}
