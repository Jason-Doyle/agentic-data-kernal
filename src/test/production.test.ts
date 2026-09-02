import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentOperation } from "../ir.js";
import type { JsonValue } from "../types.js";
import {
  authenticateToken,
  createApiKey,
  type AuthenticatedPrincipal,
} from "../production/auth.js";
import { reconcileArtifactFiles } from "../production/artifact-reconciliation.js";
import type { ProductionConfig } from "../production/config.js";
import { ProductionDatabase } from "../production/database.js";
import type { EmbeddingProvider } from "../production/embeddings.js";
import { OpenAiCompatibleEmbeddingProvider } from "../production/embeddings.js";
import {
  EffectWorker,
  SecureHttpEffectTransport,
  type EffectTransport,
} from "../production/effects.js";
import { startProductionHttpServer } from "../production/http.js";
import { ProductionKernel } from "../production/kernel.js";
import { createLogger } from "../production/logger.js";
import { MetricsRegistry } from "../production/metrics.js";
import {
  migratePostgres,
  postgresMigrationDirectory,
} from "../production/migrations.js";
import { createProductionMcpServer } from "../production/mcp.js";
import { EncryptedArtifactStore } from "../production/artifacts.js";

const databaseUrl = process.env.PRODUCTION_TEST_DATABASE_URL;
const migrationDatabaseUrl =
  process.env.PRODUCTION_TEST_MIGRATION_DATABASE_URL;

test("packaged migrations resolve relative to the module", () => {
  assert.ok(
    readdirSync(postgresMigrationDirectory).includes("001_core.sql"),
  );
});

test(
  "PostgreSQL profile enforces identity, RLS, encryption, and effect authority",
  { skip: !databaseUrl },
  async () => {
    assert.ok(databaseUrl);
    const artifactDirectory = mkdtempSync(
      join(tmpdir(), "agentic-data-production-"),
    );
    const config = testConfig(databaseUrl, artifactDirectory);
    if (migrationDatabaseUrl) {
      await migratePostgres(testConfig(migrationDatabaseUrl, artifactDirectory));
    }
    const database = new ProductionDatabase(config);
    const artifactStore = new EncryptedArtifactStore(
      artifactDirectory,
      config.artifactKeyring,
    );
    const embeddings = new TestEmbeddingProvider();
    const metrics = new MetricsRegistry();
    const logger = createLogger(config);
    const kernel = new ProductionKernel(
      database,
      artifactStore,
      embeddings,
      config,
      metrics,
      logger,
    );
    const suffix = randomUUID();
    const tenantA = `tenant-a-${suffix}`;
    const tenantB = `tenant-b-${suffix}`;
    const keyA = await createApiKey(database, config, {
      tenantId: tenantA,
      tenantName: "Tenant A",
      principalId: "agent-a",
      scopes: [
        "data:read",
        "data:write",
        "inventory:admin",
        "orders:write",
        "effects:write",
        "effects:reconcile",
        "workflows:run",
      ],
      purposes: ["test"],
      effectBudgetCurrency: "USD",
      effectBudgetLimit: "1000",
    });
    const keyB = await createApiKey(database, config, {
      tenantId: tenantB,
      tenantName: "Tenant B",
      principalId: "agent-b",
      scopes: ["data:read", "data:write"],
      purposes: ["test"],
      effectBudgetCurrency: "USD",
      effectBudgetLimit: "0",
    });
    const principalA = await authenticateToken(
      database,
      config,
      keyA.token,
      "test",
    );
    const principalB = await authenticateToken(
      database,
      config,
      keyB.token,
      "test",
    );

    try {
      await execute(kernel, principalA, "entity-a", {
        op: "put_entity",
        entity: {
          entityId: "product:1",
          entityType: "product",
          canonicalName: "Product One",
        },
      });
      await execute(kernel, principalB, "entity-b", {
        op: "put_entity",
        entity: {
          entityId: "product:1",
          entityType: "product",
          canonicalName: "Other Product",
        },
      });
      const concurrentEnvelope = {
        protocolVersion: "0.1",
        requestId: "concurrent-idempotency",
        idempotencyKey: "concurrent-idempotency",
        principal: {
          tenantId: principalA.tenantId,
          principalId: principalA.principalId,
          purpose: principalA.purpose,
        },
        operation: {
          op: "put_entity",
          entity: {
            entityId: "entity:concurrent",
            entityType: "test",
            canonicalName: "Concurrent Entity",
          },
        },
      };
      const concurrent = await Promise.all([
        kernel.execute(principalA, concurrentEnvelope),
        kernel.execute(principalA, concurrentEnvelope),
      ]);
      assert.equal(
        concurrent.filter((result) => result.idempotentReplay).length,
        1,
      );

      const visibleA = await database.withTenantTransaction(
        principalA,
        (client) =>
          client.query<{ tenant_id: string }>(
            "SELECT tenant_id FROM agentic.entities",
          ),
      );
      assert.deepEqual(
        [...new Set(visibleA.rows.map((row) => row.tenant_id))],
        [tenantA],
      );
      const noTenant = await database.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM agentic.entities",
      );
      assert.equal(Number(noTenant.rows[0]?.count), 0);

      await assert.rejects(
        () =>
          kernel.execute(principalA, {
            protocolVersion: "0.1",
            requestId: "spoof",
            principal: {
              tenantId: tenantB,
              principalId: "agent-b",
              purpose: "test",
            },
            operation: {
              op: "get_machine",
              instanceId: "anything",
            },
          }),
        /must match the authenticated principal/,
      );

      const artifact = await execute(kernel, principalA, "artifact-a", {
        op: "put_artifact",
        artifact: {
          artifactId: "artifact:secret",
          mediaType: "text/plain",
          content: "sensitive supplier evidence",
          sourceIdentity: "supplier-feed",
        },
      });
      assert.equal(field(artifact.result, "artifactId"), "artifact:secret");
      const encryptedFiles = listFiles(artifactDirectory);
      assert.equal(encryptedFiles.length, 1);
      const encrypted = readFileSync(encryptedFiles[0] ?? "");
      assert.equal(
        encrypted.includes(Buffer.from("sensitive supplier evidence")),
        false,
      );
      const filesBeforeFailedWrite = listFiles(artifactDirectory).length;
      await assert.rejects(
        () =>
          kernel.execute(principalA, {
            protocolVersion: "0.1",
            requestId: "artifact-failed-idempotency",
            idempotencyKey: "entity-a",
            principal: {
              tenantId: principalA.tenantId,
              principalId: principalA.principalId,
              purpose: principalA.purpose,
            },
            operation: {
              op: "put_artifact",
              artifact: {
                artifactId: "artifact:failed",
                mediaType: "text/plain",
                content: "must be cleaned",
                sourceIdentity: "failed-source",
              },
            },
          }),
        /used for a different request/,
      );
      assert.equal(
        listFiles(artifactDirectory).length,
        filesBeforeFailedWrite,
      );

      if (migrationDatabaseUrl) {
        await artifactStore.put(
          tenantA,
          "artifact:orphan",
          "text/plain",
          "orphan",
        );
        await assert.rejects(
          () => reconcileArtifactFiles(database, artifactStore, 0),
          /BYPASSRLS/,
        );
        const administrator = new ProductionDatabase(
          testConfig(migrationDatabaseUrl, artifactDirectory),
        );
        try {
          const reconciled = await reconcileArtifactFiles(
            administrator,
            artifactStore,
            0,
          );
          assert.equal(reconciled.removed.length, 1);
          assert.equal(listFiles(artifactDirectory).length, 1);
        } finally {
          await administrator.close();
        }

        const maintenanceDatabase = new ProductionDatabase(
          testConfig(migrationDatabaseUrl, artifactDirectory),
        );
        try {
          await maintenanceDatabase.query(
            `UPDATE agentic.maintenance_state
             SET active = TRUE, owner = 'test', started_at = clock_timestamp()
             WHERE singleton = TRUE`,
          );
          await assert.rejects(
            () =>
              execute(kernel, principalA, "maintenance-write", {
                op: "put_entity",
                entity: {
                  entityId: "entity:maintenance",
                  entityType: "test",
                  canonicalName: "Maintenance",
                },
              }),
            /Writes are paused/,
          );
        } finally {
          await maintenanceDatabase.query(
            `UPDATE agentic.maintenance_state
             SET active = FALSE, owner = NULL, started_at = NULL
             WHERE singleton = TRUE`,
          );
          await maintenanceDatabase.close();
        }
      }

      await execute(kernel, principalA, "assert-a", {
        op: "assert",
        assertion: {
          assertionId: "assertion:weight",
          subjectEntityId: "product:1",
          predicate: "packaged_weight",
          object: { type: "number", value: 4.8, unit: "kg" },
          kind: "reported_fact",
          sourceArtifactId: "artifact:secret",
        },
      });
      const replayKernel = new ProductionKernel(
        database,
        artifactStore,
        new FailingEmbeddingProvider(),
        config,
        metrics,
        logger,
      );
      const replayedAssertion = await replayKernel.execute(principalA, {
        protocolVersion: "0.1",
        requestId: "assert-replay-during-provider-outage",
        idempotencyKey: "assert-a",
        principal: {
          tenantId: principalA.tenantId,
          principalId: principalA.principalId,
          purpose: principalA.purpose,
        },
        operation: {
          op: "assert",
          assertion: {
            assertionId: "assertion:weight",
            subjectEntityId: "product:1",
            predicate: "packaged_weight",
            object: { type: "number", value: 4.8, unit: "kg" },
            kind: "reported_fact",
            sourceArtifactId: "artifact:secret",
          },
        },
      });
      assert.equal(replayedAssertion.idempotentReplay, true);

      await execute(kernel, principalA, "large-artifact", {
        op: "put_artifact",
        artifact: {
          artifactId: "artifact:large",
          mediaType: "text/plain",
          content: "x".repeat(100_000),
          sourceIdentity: "large-source",
        },
      });
      await execute(kernel, principalA, "large-assertion", {
        op: "assert",
        assertion: {
          assertionId: "assertion:large",
          subjectEntityId: "product:1",
          predicate: "large_evidence",
          object: { type: "boolean", value: true },
          kind: "observation",
          sourceArtifactId: "artifact:large",
        },
      });
      assert.ok(embeddings.longestInput <= 100_000);
      const search = await kernel.searchReadOnly(principalA, {
        op: "search",
        text: "product weight",
      });
      assert.equal(search[0]?.assertion.assertionId, "assertion:weight");

      await execute(kernel, principalA, "seed", {
        op: "seed_inventory",
        sku: "sku-1",
        location: "store-1",
        quantityOnHand: 5,
      });
      await execute(kernel, principalA, "reserve", {
        op: "reserve_inventory",
        orderId: "order-1",
        sku: "sku-1",
        location: "store-1",
        quantity: 2,
        holdSeconds: 600,
        idempotencyKey: "reserve-order-1",
      });
      const payment = await execute(kernel, principalA, "payment", {
        op: "request_payment",
        instanceId: "order:order-1",
        amount: "20",
        currency: "USD",
        paymentTarget: "https://payments.example.com/capture",
        paymentStatusUrl: "https://payments.example.com/status/payment-order-1",
        idempotencyKey: "payment-order-1",
      });
      const effectId = field(payment.result, "effectId");

      await assert.rejects(
        () =>
          execute(kernel, principalA, "forged-outcome", {
            op: "record_payment_outcome",
            effectId,
            idempotencyKey: "forged",
            status: "succeeded",
            outcome: { providerReference: "forged" },
          }),
        /accepted only from the effect worker/,
      );

      const transport: EffectTransport = {
        deliver: async () => ({
          status: "succeeded",
          responseStatus: 200,
          outcome: { providerReference: "provider-1" },
        }),
        reconcile: async () => ({
          status: "succeeded",
          responseStatus: 200,
          outcome: {
            status: "succeeded",
            providerReference: "provider-1",
          },
        }),
      };
      const worker = new EffectWorker(
        database,
        transport,
        config,
        metrics,
        logger,
      );
      assert.equal(await worker.runOnce(), true);
      const machine = await kernel.getMachineReadOnly(
        principalA,
        "order:order-1",
      );
      assert.equal(machine.state, "confirmed");
      const inventory = await database.withTenantTransaction(
        principalA,
        (client) =>
          client.query<{
            quantity_on_hand: number;
            quantity_reserved: number;
          }>(
            `SELECT quantity_on_hand, quantity_reserved
             FROM agentic.inventory
             WHERE sku = 'sku-1' AND location = 'store-1'`,
          ),
      );
      assert.equal(inventory.rows[0]?.quantity_on_hand, 3);
      assert.equal(inventory.rows[0]?.quantity_reserved, 0);
      const budget = await database.query<{
        effect_budget_reserved: string;
        effect_budget_spent: string;
      }>(
        `SELECT effect_budget_reserved, effect_budget_spent
         FROM agentic_auth.api_keys
         WHERE key_id = $1`,
        [principalA.keyId],
      );
      assert.equal(Number(budget.rows[0]?.effect_budget_reserved), 0);
      assert.equal(Number(budget.rows[0]?.effect_budget_spent), 20);

      await execute(kernel, principalA, "seed-reconcile", {
        op: "seed_inventory",
        sku: "sku-2",
        location: "store-1",
        quantityOnHand: 2,
      });
      await execute(kernel, principalA, "reserve-reconcile", {
        op: "reserve_inventory",
        orderId: "order-2",
        sku: "sku-2",
        location: "store-1",
        quantity: 1,
        holdSeconds: 600,
        idempotencyKey: "reserve-order-2",
      });
      await execute(kernel, principalA, "payment-reconcile", {
        op: "request_payment",
        instanceId: "order:order-2",
        amount: "10",
        currency: "USD",
        paymentTarget: "https://payments.example.com/capture",
        paymentStatusUrl: "https://payments.example.com/status/payment-order-2",
        idempotencyKey: "payment-order-2",
      });
      let deliveryCalls = 0;
      let reconciliationCalls = 0;
      const reconcilingTransport: EffectTransport = {
        deliver: async () => {
          deliveryCalls += 1;
          return {
            status: "unknown",
            responseStatus: 503,
            outcome: { status: "pending" },
          };
        },
        reconcile: async () => {
          reconciliationCalls += 1;
          return {
            status: "succeeded",
            responseStatus: 200,
            outcome: {
              status: "succeeded",
              providerReference: "provider-2",
            },
          };
        },
      };
      const reconcilingWorker = new EffectWorker(
        database,
        reconcilingTransport,
        { effectLeaseSeconds: 30, effectMaxAttempts: 1 },
        metrics,
        logger,
      );
      assert.equal(await reconcilingWorker.runOnce(), true);
      await database.withTenantTransaction(principalA, async (client) => {
        const status = await client.query<{ status: string }>(
          `SELECT status
           FROM agentic.effect_intents
           WHERE instance_id = 'order:order-2'`,
        );
        assert.equal(status.rows[0]?.status, "reconciling");
        await client.query(
          `UPDATE agentic.effect_intents
           SET next_attempt_at = clock_timestamp()
           WHERE instance_id = 'order:order-2'`,
        );
      });
      assert.equal(await reconcilingWorker.runOnce(), true);
      assert.equal(deliveryCalls, 1);
      assert.equal(reconciliationCalls, 1);
      assert.equal(
        (await kernel.getMachineReadOnly(principalA, "order:order-2")).state,
        "confirmed",
      );

      await assert.rejects(
        () =>
          execute(kernel, principalA, "future-timer", {
            op: "process_timers",
            asOf: "2999-01-01T00:00:00.000Z",
          }),
        /uses database server time/,
      );

      await testAuthenticatedHttp(config, database, kernel, metrics, logger, keyA.token, principalA);
      await testProductionMcp(kernel, principalA);
    } finally {
      await cleanupTenant(database, principalA);
      await cleanupTenant(database, principalB);
      await database.withSystemTransaction(async (client) => {
        await client.query(
          "DELETE FROM agentic_auth.api_keys WHERE tenant_id = ANY($1)",
          [[tenantA, tenantB]],
        );
        await client.query(
          "DELETE FROM agentic_auth.tenants WHERE tenant_id = ANY($1)",
          [[tenantA, tenantB]],
        );
      });
      await database.close();
      rmSync(artifactDirectory, { recursive: true, force: true });
    }
  },
);

test("OpenAI-compatible embedding provider validates real response shape", async () => {
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-key");
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      input: string[];
      dimensions: number;
    };
    assert.equal(body.dimensions, 1536);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: body.input.map((_, index) => ({
          index,
          embedding: vector(index + 1),
        })),
        model: "test-model",
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const provider = new OpenAiCompatibleEmbeddingProvider(
      `http://127.0.0.1:${port}`,
      "test-key",
      "test-model",
      1536,
      5_000,
    );
    const embeddings = await provider.embed(["one", "two"]);
    assert.equal(embeddings.length, 2);
    assert.equal(embeddings[0]?.length, 1536);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("encrypted artifact writes are race-safe and retain their key version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-data-artifact-race-"));
  try {
    const firstStore = new EncryptedArtifactStore(directory, {
      currentKeyId: "v1",
      keys: new Map([["v1", Buffer.alloc(32, 1)]]),
    });
    const [first, replay] = await Promise.all([
      firstStore.put("tenant", "artifact", "text/plain", "content"),
      firstStore.put("tenant", "artifact", "text/plain", "content"),
    ]);
    assert.equal([first.created, replay.created].filter(Boolean).length, 1);

    const rotatedStore = new EncryptedArtifactStore(directory, {
      currentKeyId: "v2",
      keys: new Map([
        ["v1", Buffer.alloc(32, 1)],
        ["v2", Buffer.alloc(32, 2)],
      ]),
    });
    const existing = await rotatedStore.put(
      "tenant",
      "artifact",
      "text/plain",
      "content",
    );
    assert.equal(existing.created, false);
    assert.equal(existing.encryptionKeyId, "v1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("secure effect transport rejects private destinations", async () => {
  const transport = new SecureHttpEffectTransport(
    new Set(["127.0.0.1"]),
    1_000,
  );
  const result = await transport.deliver({
    effectId: "effect-1",
    authorizationFence: "fence-1",
    idempotencyKey: "idempotency-1",
    targetUrl: "https://127.0.0.1/payment",
    request: {},
  });
  assert.equal(result.status, "failed");
  assert.match(field(result.outcome, "error"), /private or reserved/);
});

class TestEmbeddingProvider implements EmbeddingProvider {
  public readonly model = "test-embedding";
  public readonly version = "1";
  public readonly dimensions = 1536;
  public longestInput = 0;

  public async embed(texts: string[]): Promise<number[][]> {
    this.longestInput = Math.max(
      this.longestInput,
      ...texts.map((text) => text.length),
    );
    return texts.map((text) => vector(text.length || 1));
  }
}

class FailingEmbeddingProvider implements EmbeddingProvider {
  public readonly model = "failing";
  public readonly version = "1";
  public readonly dimensions = 1536;

  public async embed(): Promise<number[][]> {
    throw new Error("Embedding provider unavailable");
  }
}

function vector(seed: number): number[] {
  const result = Array.from({ length: 1536 }, () => 0);
  result[seed % result.length] = 1;
  return result;
}

function testConfig(
  url: string,
  artifactDirectory: string,
): ProductionConfig {
  return {
    databaseUrl: url,
    databaseSsl: false,
    databasePoolSize: 10,
    statementTimeoutMs: 30_000,
    authPepper: "test-pepper-with-at-least-thirty-two-characters",
    artifactDirectory,
    artifactKeyring: {
      currentKeyId: "v1",
      keys: new Map([["v1", Buffer.alloc(32, 7)]]),
    },
    embeddingBaseUrl: "https://embeddings.example.com/v1",
    embeddingApiKey: "test",
    embeddingModel: "test",
    embeddingDimensions: 1536,
    embeddingTimeoutMs: 5_000,
    effectAllowedHosts: new Set(["payments.example.com"]),
    effectTimeoutMs: 5_000,
    effectLeaseSeconds: 30,
    effectMaxAttempts: 5,
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    maxBodyBytes: 1_000_000,
    rateLimitPerMinute: 1_000,
  };
}

async function execute(
  kernel: ProductionKernel,
  principal: AuthenticatedPrincipal,
  key: string,
  operation: AgentOperation,
) {
  return kernel.execute(principal, {
    protocolVersion: "0.1",
    requestId: `${key}-${randomUUID()}`,
    idempotencyKey: key,
    principal: {
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      purpose: principal.purpose,
    },
    operation,
  });
}

function field(value: JsonValue, name: string): string {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    typeof value[name] !== "string"
  ) {
    throw new Error(`Expected ${name}`);
  }
  return value[name];
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files;
}

async function testAuthenticatedHttp(
  config: ProductionConfig,
  database: ProductionDatabase,
  kernel: ProductionKernel,
  metrics: MetricsRegistry,
  logger: ReturnType<typeof createLogger>,
  token: string,
  principal: AuthenticatedPrincipal,
): Promise<void> {
  const server = await startProductionHttpServer({
    config,
    database,
    kernel,
    metrics,
    logger,
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const unauthorized = await fetch(`${base}/v1/catalog`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${base}/v1/catalog`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-agent-purpose": "test",
      },
    });
    assert.equal(authorized.status, 200);
    const missingSql = await fetch(`${base}/v1/sql`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-agent-purpose": "test",
      },
    });
    assert.equal(missingSql.status, 404);
    const spoof = await fetch(`${base}/v1/execute`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-agent-purpose": "test",
      },
      body: JSON.stringify({
        protocolVersion: "0.1",
        requestId: "http-spoof",
        principal: {
          tenantId: `${principal.tenantId}-other`,
          principalId: principal.principalId,
          purpose: "test",
        },
        operation: {
          op: "get_machine",
          instanceId: "order:order-1",
        },
      }),
    });
    assert.equal(spoof.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function cleanupTenant(
  database: ProductionDatabase,
  principal: AuthenticatedPrincipal,
): Promise<void> {
  await database.withTenantTransaction(principal, async (client) => {
    for (const table of [
      "effect_attempts",
      "effect_intents",
      "timers",
      "machine_history",
      "machine_instances",
      "inventory",
      "assertions",
      "artifacts",
      "execution_receipts",
      "idempotency_results",
      "entities",
    ]) {
      await client.query(`DELETE FROM agentic.${table}`);
    }
  });
}

async function testProductionMcp(
  kernel: ProductionKernel,
  principal: AuthenticatedPrincipal,
): Promise<void> {
  const server = createProductionMcpServer(kernel, principal);
  const client = new Client({
    name: "production-mcp-test",
    version: "0.2.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "execute_operation"));
    assert.ok(
      !tools.tools.some((tool) => tool.name === "record_payment_outcome"),
    );
    const result = await client.callTool({
      name: "get_machine",
      arguments: { instanceId: "order:order-1" },
    });
    assert.ok(Array.isArray(result.content));
  } finally {
    await client.close();
    await server.close();
  }
}
