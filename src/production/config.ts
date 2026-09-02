import * as z from "zod/v4";

const baseSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300_000)
    .default(30_000),
});

const serverSchema = baseSchema.extend({
  AUTH_PEPPER: z.string().min(32),
  ARTIFACT_KEYRING: z.string().min(1),
  ARTIFACT_CURRENT_KEY_ID: z.string().trim().min(1),
  ARTIFACT_DIR: z.string().trim().min(1).default(".data/artifacts"),
  EMBEDDING_BASE_URL: z.string().url(),
  EMBEDDING_API_KEY: z.string().min(1),
  EMBEDDING_MODEL: z.string().trim().min(1).default("text-embedding-3-small"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  EMBEDDING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(30_000),
  EFFECT_ALLOWED_HOSTS: z.string().default(""),
  EFFECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(15_000),
  EFFECT_LEASE_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(600)
    .default(30),
  EFFECT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4318),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(10_000_000)
    .default(1_000_000),
  RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(600),
});

export interface DatabaseConfig {
  databaseUrl: string;
  databaseSsl: boolean;
  databasePoolSize: number;
  statementTimeoutMs: number;
}

export interface ArtifactKeyringConfig {
  currentKeyId: string;
  keys: Map<string, Buffer>;
}

export interface ProductionConfig extends DatabaseConfig {
  authPepper: string;
  artifactDirectory: string;
  artifactKeyring: ArtifactKeyringConfig;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingTimeoutMs: number;
  effectAllowedHosts: Set<string>;
  effectTimeoutMs: number;
  effectLeaseSeconds: number;
  effectMaxAttempts: number;
  host: string;
  port: number;
  logLevel:
    | "fatal"
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace"
    | "silent";
  maxBodyBytes: number;
  rateLimitPerMinute: number;
}

export function loadDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const parsed = parse(baseSchema, environment);
  return {
    databaseUrl: parsed.DATABASE_URL,
    databaseSsl: parsed.DATABASE_SSL === "require",
    databasePoolSize: parsed.DATABASE_POOL_SIZE,
    statementTimeoutMs: parsed.DATABASE_STATEMENT_TIMEOUT_MS,
  };
}

export function loadMigrationDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  return loadDatabaseConfig({
    ...environment,
    DATABASE_URL:
      environment.MIGRATION_DATABASE_URL ?? environment.DATABASE_URL,
  });
}

export function loadProductionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProductionConfig {
  const parsed = parse(serverSchema, environment);
  if (parsed.EMBEDDING_DIMENSIONS !== 1536) {
    throw new Error(
      "EMBEDDING_DIMENSIONS must be 1536 for the current PostgreSQL schema",
    );
  }

  const artifactKeyring = parseArtifactKeyring(
    parsed.ARTIFACT_KEYRING,
    parsed.ARTIFACT_CURRENT_KEY_ID,
  );
  const effectAllowedHosts = new Set(
    parsed.EFFECT_ALLOWED_HOSTS.split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );

  return {
    databaseUrl: parsed.DATABASE_URL,
    databaseSsl: parsed.DATABASE_SSL === "require",
    databasePoolSize: parsed.DATABASE_POOL_SIZE,
    statementTimeoutMs: parsed.DATABASE_STATEMENT_TIMEOUT_MS,
    authPepper: parsed.AUTH_PEPPER,
    artifactDirectory: parsed.ARTIFACT_DIR,
    artifactKeyring,
    embeddingBaseUrl: parsed.EMBEDDING_BASE_URL,
    embeddingApiKey: parsed.EMBEDDING_API_KEY,
    embeddingModel: parsed.EMBEDDING_MODEL,
    embeddingDimensions: parsed.EMBEDDING_DIMENSIONS,
    embeddingTimeoutMs: parsed.EMBEDDING_TIMEOUT_MS,
    effectAllowedHosts,
    effectTimeoutMs: parsed.EFFECT_TIMEOUT_MS,
    effectLeaseSeconds: parsed.EFFECT_LEASE_SECONDS,
    effectMaxAttempts: parsed.EFFECT_MAX_ATTEMPTS,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    maxBodyBytes: parsed.MAX_BODY_BYTES,
    rateLimitPerMinute: parsed.RATE_LIMIT_PER_MINUTE,
  };
}

function parse<T>(
  schema: z.ZodType<T>,
  environment: NodeJS.ProcessEnv,
): T {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid production configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function parseArtifactKeyring(
  raw: string,
  currentKeyId: string,
): ArtifactKeyringConfig {
  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("ARTIFACT_KEYRING must be a JSON object");
  }
  const parsed = z.record(z.string().min(1), z.string().min(1)).safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid ARTIFACT_KEYRING:\n${z.prettifyError(parsed.error)}`);
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(parsed.data)) {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error(`Artifact key ${keyId} must decode to exactly 32 bytes`);
    }
    keys.set(keyId, key);
  }
  if (!keys.has(currentKeyId)) {
    throw new Error(
      `ARTIFACT_CURRENT_KEY_ID ${currentKeyId} is not present in ARTIFACT_KEYRING`,
    );
  }
  return { currentKeyId, keys };
}
