#!/usr/bin/env node

import {
  authenticateToken,
  createApiKey,
  revokeApiKey,
} from "./auth.js";
import {
  formatTraceExplanation,
  normalizeTraceDepth,
  parseTraceEndpoint,
} from "../explain.js";
import { reconcileArtifactFiles } from "./artifact-reconciliation.js";
import {
  configuredEmbeddingSpace,
  loadDatabaseConfig,
  loadEmbeddingSpaceConfig,
  loadMigrationDatabaseConfig,
  loadProductionConfig,
} from "./config.js";
import { ProductionDatabase } from "./database.js";
import { assertEmbeddingSpaceConfigured } from "./embedding-space.js";
import {
  EffectWorker,
  SecureHttpEffectTransport,
} from "./effects.js";
import { startProductionHttpServer } from "./http.js";
import { runLoad } from "./load.js";
import {
  assertMigrationsApplied,
  migrationStatus,
  migratePostgres,
} from "./migrations.js";
import { startProductionMcpServer } from "./mcp.js";
import { createProductionRuntime } from "./runtime.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "migrate": {
      const embeddingSpace = loadEmbeddingSpaceConfig();
      const applied = await migratePostgres(
        loadMigrationDatabaseConfig(),
        undefined,
        embeddingSpace,
      );
      print({ applied, embeddingSpace });
      return;
    }
    case "migration-status": {
      print({ migrations: await migrationStatus(loadMigrationDatabaseConfig()) });
      return;
    }
    case "create-key": {
      const databaseConfig = loadDatabaseConfig();
      await migratePostgres(
        loadMigrationDatabaseConfig(),
        undefined,
        loadEmbeddingSpaceConfig(),
      );
      const pepper = requiredEnvironment("AUTH_PEPPER", 32);
      const database = new ProductionDatabase(databaseConfig);
      try {
        const result = await createApiKey(
          database,
          { authPepper: pepper },
          {
            tenantId: requiredOption(args, "--tenant"),
            tenantName:
              option(args, "--tenant-name") ??
              requiredOption(args, "--tenant"),
            principalId: requiredOption(args, "--principal"),
            scopes: csv(
              option(args, "--scopes") ??
                "data:read,data:write,orders:write,effects:write",
            ),
            purposes: csv(option(args, "--purposes") ?? "*"),
            effectBudgetCurrency:
              option(args, "--effect-currency") ?? "USD",
            effectBudgetLimit: option(args, "--effect-budget") ?? "0",
            expiresAt: option(args, "--expires"),
          },
        );
        print({
          keyId: result.keyId,
          token: result.token,
          warning: "The token is shown once and is not stored in plaintext.",
        });
      } finally {
        await database.close();
      }
      return;
    }
    case "revoke-key": {
      const config = loadDatabaseConfig();
      const database = new ProductionDatabase(config);
      try {
        await database.withSystemWriteTransaction((client) =>
          revokeApiKey(client, requiredOption(args, "--key-id")),
        );
        print({ revoked: true });
      } finally {
        await database.close();
      }
      return;
    }
    case "serve": {
      const config = loadProductionConfig();
      const runtime = createProductionRuntime(config);
      await assertRuntimeReady(runtime.database, config);
      const server = await startProductionHttpServer({
        config,
        database: runtime.database,
        kernel: runtime.kernel,
        metrics: runtime.metrics,
        logger: runtime.logger,
      });
      runtime.logger.info(
        { host: config.host, port: config.port },
        "Production server started",
      );
      await waitForServerShutdown(server, runtime.database);
      return;
    }
    case "worker": {
      const config = loadProductionConfig();
      const runtime = createProductionRuntime(config);
      await assertRuntimeReady(runtime.database, config);
      const worker = new EffectWorker(
        runtime.database,
        new SecureHttpEffectTransport(
          config.effectAllowedHosts,
          config.effectTimeoutMs,
        ),
        config,
        runtime.metrics,
        runtime.logger,
      );
      if (args.includes("--once")) {
        const worked = await worker.runOnce();
        print({ worked });
        await runtime.database.close();
        return;
      }
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      runtime.logger.info("Effect worker started");
      await worker.run(controller.signal);
      await runtime.database.close();
      return;
    }
    case "reconcile-artifacts": {
      if (!process.env.MIGRATION_DATABASE_URL) {
        throw new Error(
          "MIGRATION_DATABASE_URL is required for artifact reconciliation",
        );
      }
      const config = loadProductionConfig();
      const database = new ProductionDatabase(loadMigrationDatabaseConfig());
      const runtime = createProductionRuntime(config);
      try {
        const result = await reconcileArtifactFiles(
          database,
          runtime.artifactStore,
          Number(option(args, "--minimum-age-ms") ?? "3600000"),
        );
        print(result);
      } finally {
        await database.close();
        await runtime.database.close();
      }
      return;
    }
    case "mcp": {
      const config = loadProductionConfig();
      const runtime = createProductionRuntime(config);
      await assertRuntimeReady(runtime.database, config);
      const token = requiredEnvironment("AGENTIC_DATA_API_KEY", 1);
      const purpose = requiredEnvironment("AGENTIC_DATA_PURPOSE", 1);
      const principal = await authenticateToken(
        runtime.database,
        config,
        token,
        purpose,
      );
      const server = await startProductionMcpServer(
        runtime.kernel,
        principal,
      );
      const close = async (): Promise<void> => {
        await server.close();
        await runtime.database.close();
      };
      process.once("SIGINT", () => void close());
      process.once("SIGTERM", () => void close());
      return;
    }
    case "explain": {
      const config = loadProductionConfig();
      const runtime = createProductionRuntime(config);
      try {
        await assertRuntimeReady(runtime.database, config);
        const principal = await authenticateToken(
          runtime.database,
          config,
          requiredEnvironment("AGENTIC_DATA_API_KEY", 1),
          requiredEnvironment("AGENTIC_DATA_PURPOSE", 1),
        );
        const explanation = await runtime.kernel.explainReadOnly(
          principal,
          parseTraceEndpoint(
            requiredOption(args, "--type"),
            requiredOption(args, "--id"),
            option(args, "--revision"),
          ),
          normalizeTraceDepth(Number(option(args, "--depth") ?? "4")),
        );
        if (args.includes("--json")) {
          print(explanation);
        } else {
          console.log(formatTraceExplanation(explanation));
        }
      } finally {
        await runtime.database.close();
      }
      return;
    }
    case "load": {
      const result = await runLoad({
        baseUrl: option(args, "--url") ?? "https://localhost:8443",
        token:
          option(args, "--token") ??
          requiredEnvironment("AGENTIC_DATA_API_KEY", 1),
        purpose:
          option(args, "--purpose") ??
          requiredEnvironment("AGENTIC_DATA_PURPOSE", 1),
        tenantId: requiredOption(args, "--tenant"),
        principalId: requiredOption(args, "--principal"),
        requests: positiveInteger(option(args, "--requests") ?? "100"),
        concurrency: positiveInteger(option(args, "--concurrency") ?? "10"),
      });
      print(result);
      if (result.failed > 0) {
        process.exitCode = 1;
      }
      return;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(helpText);
      return;
    default:
      throw new Error(`Unknown production command ${command}`);
  }
}

async function assertRuntimeReady(
  database: ProductionDatabase,
  config: ReturnType<typeof loadProductionConfig>,
): Promise<void> {
  await assertMigrationsApplied(database);
  await assertEmbeddingSpaceConfigured(
    database,
    configuredEmbeddingSpace(config),
  );
}

async function waitForServerShutdown(
  server: import("node:http").Server,
  database: ProductionDatabase,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await database.close();
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredEnvironment(name: string, minimumLength: number): string {
  const value = process.env[name];
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${value} must be a positive integer`);
  }
  return parsed;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const helpText = `Agentic Data Kernel production profile

Commands:
  migrate
  migration-status
  create-key --tenant ID --principal ID [--tenant-name NAME]
             [--scopes CSV] [--purposes CSV] [--effect-budget DECIMAL]
             [--effect-currency USD]
             [--expires ISO_TIMESTAMP]
  revoke-key --key-id UUID
  serve
  worker [--once]
  reconcile-artifacts [--minimum-age-ms N]
  mcp
  explain --type TYPE --id ID [--revision N] [--depth N] [--json]
  load --tenant ID --principal ID [--url URL] [--token TOKEN]
       [--purpose PURPOSE] [--requests N] [--concurrency N]
`;

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
