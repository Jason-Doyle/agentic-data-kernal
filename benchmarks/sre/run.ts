import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Client } from "pg";
import {
  SyntheticRemediationTransport,
  type ProductionConfig,
} from "../../src/production/index.js";
import { runConventionalBaseline } from "./baseline.js";
import { runKernelVariant } from "./kernel.js";
import {
  assertCorrectness,
  auditQuestions,
  type BenchmarkMeasurement,
} from "./shared.js";

const repetitions = positiveInteger(
  process.env.BENCHMARK_REPETITIONS ?? "3",
);
const adminBase =
  process.env.BENCHMARK_DATABASE_URL ??
  required("PRODUCTION_TEST_MIGRATION_DATABASE_URL");
const appBase =
  process.env.BENCHMARK_APP_DATABASE_URL ??
  required("PRODUCTION_TEST_DATABASE_URL");
const control = new Client({
  connectionString: databaseUrlFor(adminBase, "postgres"),
});
const measurements: BenchmarkMeasurement[] = [];
const workspace = mkdtempSync(join(tmpdir(), "agentic-sre-benchmark-"));
let postgresVersion = "";

try {
  await control.connect();
  const version = await control.query<{ server_version: string }>(
    "SHOW server_version",
  );
  postgresVersion = version.rows[0]?.server_version ?? "unknown";
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    measurements.push(
      await runVariant("conventional-postgres", repetition),
      await runVariant("agentic-data-kernel", repetition),
    );
  }
} finally {
  await control.end();
  rmSync(workspace, { recursive: true, force: true });
}

const summary = createSummary(measurements);
console.log(JSON.stringify(summary, null, 2));
if (process.env.BENCHMARK_WRITE_RESULTS === "1") {
  const resultsDirectory = resolve("benchmarks", "sre", "results");
  mkdirSync(resultsDirectory, { recursive: true });
  writeFileSync(
    join(resultsDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  writeFileSync(
    join(resultsDirectory, "report.md"),
    renderReport(summary),
  );
}

async function runVariant(
  variant: "conventional-postgres" | "agentic-data-kernel",
  repetition: number,
): Promise<BenchmarkMeasurement> {
  const suffix = `${variant === "agentic-data-kernel" ? "adk" : "pg"}_${Date.now()}_${repetition}`;
  const databaseName = `agentic_bench_${suffix}`;
  await control.query(`CREATE DATABASE ${databaseName}`);
  const adminUrl = databaseUrlFor(adminBase, databaseName);
  const appUrl = databaseUrlFor(appBase, databaseName);
  const artifactDirectory = join(workspace, databaseName);
  mkdirSync(artifactDirectory, { recursive: true });
  try {
    const remediation = new SyntheticRemediationTransport();
    const outcome =
      variant === "conventional-postgres"
        ? await runConventionalBaseline({
            databaseUrl: adminUrl,
            runId: `${repetition}`,
            remediation,
          })
        : await runKernelVariant({
            config: testConfig(appUrl, artifactDirectory),
            migrationConfig: {
              ...testConfig(adminUrl, artifactDirectory),
              databaseUrl: adminUrl,
            },
            runId: `${repetition}`,
            remediation,
          });
    assertCorrectness(outcome);
    const metrics = await databaseMetrics(adminUrl);
    return { outcome, ...metrics };
  } finally {
    await control.query(
      `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
    );
  }
}

async function databaseMetrics(databaseUrl: string): Promise<{
  operatedTables: number;
  databaseBytes: number;
}> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("VACUUM ANALYZE");
    const result = await client.query<{
      table_count: string;
      total_bytes: string;
    }>(
      `SELECT
         count(*)::TEXT AS table_count,
         COALESCE(sum(pg_total_relation_size(
           quote_ident(schemaname) || '.' || quote_ident(tablename)
         )), 0)::TEXT AS total_bytes
       FROM pg_tables
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
    );
    return {
      operatedTables: Number(result.rows[0]?.table_count ?? "0"),
      databaseBytes: Number(result.rows[0]?.total_bytes ?? "0"),
    };
  } finally {
    await client.end();
  }
}

function createSummary(values: BenchmarkMeasurement[]) {
  const byVariant = (variant: BenchmarkMeasurement["outcome"]["variant"]) =>
    values.filter((value) => value.outcome.variant === variant);
  const baseline = byVariant("conventional-postgres");
  const kernel = byVariant("agentic-data-kernel");
  return {
    schemaVersion: 1,
    repetitions,
    environment: {
      node: process.version,
      postgres: postgresVersion,
      commit: gitCommit(),
    },
    runs: values,
    correctness: {
      conventionalPostgres: passSummary(baseline),
      agenticDataKernel: passSummary(kernel),
    },
    applicationSurface: {
      conventionalPostgres: {
        nonblankLines: sourceLines([
          "benchmarks/sre/baseline.ts",
          "benchmarks/sre/baseline-schema.sql",
        ]),
        authoredTables: 8,
        operatedTables: median(baseline.map((value) => value.operatedTables)),
      },
      agenticDataKernel: {
        nonblankLines: sourceLines(["benchmarks/sre/kernel.ts"]),
        authoredTables: 0,
        operatedTables: median(kernel.map((value) => value.operatedTables)),
        dependencySourceLines: sourceLines(
          listFiles("src").filter(
            (path) =>
              extname(path) === ".ts" &&
              !path.split(/[\\/]/).includes("test"),
          ),
        ),
      },
    },
    databaseBytes: {
      conventionalPostgresMedian: median(
        baseline.map((value) => value.databaseBytes),
      ),
      agenticDataKernelMedian: median(
        kernel.map((value) => value.databaseBytes),
      ),
    },
    runtimeMillisecondsInformational: {
      conventionalPostgresMedian: median(
        baseline.map((value) => value.outcome.durationMs),
      ),
      agenticDataKernelMedian: median(
        kernel.map((value) => value.outcome.durationMs),
      ),
    },
    explanationQuestions: auditQuestions.length,
    claims: {
      correctnessParityRequired: true,
      runtimeSuperiorityClaimed: false,
      processCrashRecoveryMeasured: false,
    },
  };
}

function passSummary(values: BenchmarkMeasurement[]) {
  return {
    passed: values.length,
    attempted: repetitions,
    deliveryCounts: values.map((value) => value.outcome.deliveryCount),
    reconciliationCounts: values.map(
      (value) => value.outcome.reconciliationCount,
    ),
    explanationScores: values.map(
      (value) =>
        Object.values(value.outcome.auditAnswers).filter(Boolean).length,
    ),
  };
}

function renderReport(summary: ReturnType<typeof createSummary>): string {
  const baseline = summary.applicationSurface.conventionalPostgres;
  const kernel = summary.applicationSurface.agenticDataKernel;
  return `# SRE Incident Benchmark

Generated from \`summary.json\`.

## Correctness

Both variants must resolve every run with one delivery and one reconciliation.

| Variant | Passed | Delivery counts | Reconciliation counts | Audit score |
| --- | ---: | --- | --- | --- |
| Conventional PostgreSQL | ${summary.correctness.conventionalPostgres.passed}/${summary.repetitions} | ${summary.correctness.conventionalPostgres.deliveryCounts.join(", ")} | ${summary.correctness.conventionalPostgres.reconciliationCounts.join(", ")} | ${summary.correctness.conventionalPostgres.explanationScores.join(", ")} / ${summary.explanationQuestions} |
| Agentic Data Kernel | ${summary.correctness.agenticDataKernel.passed}/${summary.repetitions} | ${summary.correctness.agenticDataKernel.deliveryCounts.join(", ")} | ${summary.correctness.agenticDataKernel.reconciliationCounts.join(", ")} | ${summary.correctness.agenticDataKernel.explanationScores.join(", ")} / ${summary.explanationQuestions} |

## Application-owned surface

| Variant | Nonblank app lines | App-authored tables | Operated tables |
| --- | ---: | ---: | ---: |
| Conventional PostgreSQL | ${baseline.nonblankLines} | ${baseline.authoredTables} | ${baseline.operatedTables} |
| Agentic Data Kernel adapter | ${kernel.nonblankLines} | ${kernel.authoredTables} | ${kernel.operatedTables} |

The kernel dependency contains ${kernel.dependencySourceLines} nonblank TypeScript
source lines. That code is not application-authored, but it remains
infrastructure that adopters operate and upgrade.

## Database footprint

| Variant | Median bytes |
| --- | ---: |
| Conventional PostgreSQL | ${summary.databaseBytes.conventionalPostgresMedian} |
| Agentic Data Kernel | ${summary.databaseBytes.agenticDataKernelMedian} |

## Informational runtime

| Variant | Median milliseconds |
| --- | ---: |
| Conventional PostgreSQL | ${summary.runtimeMillisecondsInformational.conventionalPostgresMedian.toFixed(2)} |
| Agentic Data Kernel | ${summary.runtimeMillisecondsInformational.agenticDataKernelMedian.toFixed(2)} |

Runtime is not a headline metric. The variants perform different work and this
deterministic smoke benchmark is not a latency study.

## Not claimed

- The benchmark does not claim that PostgreSQL cannot implement safe recovery.
- The benchmark requires correctness parity.
- It does not measure operating-system process crash recovery.
- It does not claim runtime or storage superiority.
- LOC is a structural observation, not a productivity measurement.
`;
}

function testConfig(
  databaseUrl: string,
  artifactDirectory: string,
): ProductionConfig {
  return {
    databaseUrl,
    databaseSsl: false,
    databasePoolSize: 10,
    statementTimeoutMs: 30_000,
    authPepper: "benchmark-pepper-with-at-least-thirty-two-characters",
    artifactDirectory,
    artifactKeyring: {
      currentKeyId: "v1",
      keys: new Map([["v1", Buffer.alloc(32, 13)]]),
    },
    embeddingBaseUrl: "https://embeddings.example.com/v1",
    embeddingApiKey: "unused",
    embeddingModel: "benchmark",
    embeddingVersion: "1",
    embeddingDimensions: 384,
    embeddingTimeoutMs: 5_000,
    searchCandidateLimit: 100,
    hnswEfSearch: 100,
    hnswMaxScanTuples: 20_000,
    effectAllowedHosts: new Set(),
    effectTimeoutMs: 5_000,
    effectLeaseSeconds: 30,
    effectMaxAttempts: 1,
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    maxBodyBytes: 1_000_000,
    rateLimitPerMinute: 1_000,
  };
}

function sourceLines(paths: string[]): number {
  return paths.reduce(
    (total, path) =>
      total +
      readFileSync(resolve(path), "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0).length,
    0,
  );
}

function listFiles(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      paths.push(join(entry.parentPath, entry.name));
    }
  }
  return paths;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function gitCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function databaseUrlFor(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error("BENCHMARK_REPETITIONS must be an integer from 1 to 20");
  }
  return parsed;
}
