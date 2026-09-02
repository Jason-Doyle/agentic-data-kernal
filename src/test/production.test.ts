import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client as PgClient } from "pg";
import { toSql as vectorToSql } from "pgvector";
import type { AgentOperation } from "../ir.js";
import { KernelError } from "../kernel.js";
import type { JsonValue } from "../types.js";
import {
  authenticateToken,
  createApiKey,
  revokeApiKey,
  type AuthenticatedPrincipal,
} from "../production/auth.js";
import { reconcileArtifactFiles } from "../production/artifact-reconciliation.js";
import {
  configuredEmbeddingSpace,
  loadEmbeddingSpaceConfig,
  type ProductionConfig,
} from "../production/config.js";
import { ProductionDatabase } from "../production/database.js";
import {
  assertEmbeddingSpaceConfigured,
  configureEmbeddingSpace,
  embeddingIndexName,
  embeddingSpaceStatus,
} from "../production/embedding-space.js";
import type { EmbeddingProvider } from "../production/embeddings.js";
import {
  OpenAiCompatibleEmbeddingProvider,
  validateEmbeddingVector,
} from "../production/embeddings.js";
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
import { buildHybridSearchQuery } from "../production/search.js";

const databaseUrl = process.env.PRODUCTION_TEST_DATABASE_URL;
const migrationDatabaseUrl =
  process.env.PRODUCTION_TEST_MIGRATION_DATABASE_URL;

test("packaged migrations resolve relative to the module", () => {
  const migrations = readdirSync(postgresMigrationDirectory);
  assert.ok(migrations.includes("001_core.sql"));
  assert.ok(migrations.includes("002_embedding_space.sql"));
  assert.ok(migrations.includes("003_generic_agency.sql"));
  const embeddingMigration = readFileSync(
    join(postgresMigrationDirectory, "002_embedding_space.sql"),
    "utf8",
  );
  assert.ok(
    embeddingMigration.indexOf("pgvector 0.8.0 or newer is required") <
      embeddingMigration.indexOf(
        "DROP INDEX agentic.assertions_embedding_hnsw",
      ),
  );
});

test("embedding dimensions are validated as deployment configuration", () => {
  assert.deepEqual(
    loadEmbeddingSpaceConfig({
      EMBEDDING_MODEL: "custom-model",
      EMBEDDING_VERSION: "weights-2",
      EMBEDDING_DIMENSIONS: "768",
    }),
    {
      model: "custom-model",
      version: "weights-2",
      dimensions: 768,
    },
  );
  assert.throws(
    () =>
      loadEmbeddingSpaceConfig({
        EMBEDDING_DIMENSIONS: "2001",
      }),
    /2000/,
  );
  assert.throws(
    () => validateEmbeddingVector([0, 0, 0], 3),
    /must not be zero vectors/,
  );
});

test(
  "embedding migration preserves an existing 1536-dimensional space",
  { skip: !databaseUrl || !migrationDatabaseUrl },
  async () => {
    assert.ok(databaseUrl);
    assert.ok(migrationDatabaseUrl);
    const databaseName = `agentic_upgrade_${randomUUID().replaceAll("-", "")}`;
    const artifactDirectory = mkdtempSync(
      join(tmpdir(), "agentic-data-embedding-upgrade-"),
    );
    const control = new PgClient({
      connectionString: databaseUrlFor(migrationDatabaseUrl, "postgres"),
    });
    const adminUrl = databaseUrlFor(migrationDatabaseUrl, databaseName);
    const appUrl = databaseUrlFor(databaseUrl, databaseName);
    let controlConnected = false;
    let databaseCreated = false;
    let appDatabase: ProductionDatabase | null = null;
    try {
      await control.connect();
      controlConnected = true;
      await control.query(`CREATE DATABASE ${databaseName}`);
      databaseCreated = true;

      const source = readFileSync(
        join(postgresMigrationDirectory, "001_core.sql"),
        "utf8",
      );
      const checksum = createHash("sha256").update(source).digest("hex");
      const adminDatabase = new ProductionDatabase(
        testConfig(adminUrl, artifactDirectory),
      );
      try {
        await adminDatabase.withSystemTransaction(async (client) => {
          await client.query("CREATE SCHEMA IF NOT EXISTS agentic");
          await client.query(
            `CREATE TABLE agentic.schema_migrations (
               version TEXT PRIMARY KEY,
               file_name TEXT NOT NULL,
               checksum TEXT NOT NULL,
               applied_at TIMESTAMPTZ NOT NULL
             )`,
          );
          await client.query(source);
          await client.query(
            `INSERT INTO agentic.schema_migrations (
               version, file_name, checksum, applied_at
             ) VALUES ('001', '001_core.sql', $1, clock_timestamp())`,
            [checksum],
          );
        });
      } finally {
        await adminDatabase.close();
      }

      const config = testConfig(appUrl, artifactDirectory);
      appDatabase = new ProductionDatabase(config);
      const provider = new TestEmbeddingProvider();
      const kernel = new ProductionKernel(
        appDatabase,
        new EncryptedArtifactStore(
          artifactDirectory,
          config.artifactKeyring,
        ),
        provider,
        config,
        new MetricsRegistry(),
        createLogger(config),
      );
      const key = await createApiKey(appDatabase, config, {
        tenantId: "upgrade-tenant",
        tenantName: "Upgrade Tenant",
        principalId: "upgrade-agent",
        scopes: ["data:read", "data:write"],
        purposes: ["test"],
        effectBudgetCurrency: "USD",
        effectBudgetLimit: "0",
      });
      const principal = await authenticateToken(
        appDatabase,
        config,
        key.token,
        "test",
      );
      await execute(kernel, principal, "upgrade-entity", {
        op: "put_entity",
        entity: {
          entityId: "product:upgrade",
          entityType: "product",
          canonicalName: "Upgrade Product",
        },
      });
      await execute(kernel, principal, "upgrade-assertion", {
        op: "assert",
        assertion: {
          assertionId: "assertion:upgrade",
          subjectEntityId: "product:upgrade",
          predicate: "description",
          object: { type: "string", value: "preserved assertion" },
          kind: "reported_fact",
        },
      });
      await appDatabase.close();
      appDatabase = null;

      await assert.rejects(
        () =>
          migratePostgres(
            testConfig(adminUrl, artifactDirectory, {
              dimensions: 768,
              model: "wrong-model",
              version: "1",
            }),
            undefined,
            {
              dimensions: 768,
              model: "wrong-model",
              version: "1",
            },
          ),
        /does not match existing assertions/,
      );
      const unchangedDatabase = new ProductionDatabase(
        testConfig(adminUrl, artifactDirectory),
      );
      try {
        const unchanged = await unchangedDatabase.query<{
          migration_applied: boolean;
          legacy_index_present: boolean;
        }>(
          `SELECT
             EXISTS (
               SELECT 1
               FROM agentic.schema_migrations
               WHERE version = '002'
             ) AS migration_applied,
             to_regclass(
               'agentic.assertions_embedding_hnsw'
             ) IS NOT NULL AS legacy_index_present`,
        );
        assert.deepEqual(unchanged.rows[0], {
          migration_applied: false,
          legacy_index_present: true,
        });
      } finally {
        await unchangedDatabase.close();
      }

      await migratePostgres(
        testConfig(adminUrl, artifactDirectory),
        undefined,
        configuredEmbeddingSpace(config),
      );

      appDatabase = new ProductionDatabase(config);
      await assertEmbeddingSpaceConfigured(
        appDatabase,
        configuredEmbeddingSpace(config),
      );
      const migrated = await appDatabase.withTenantTransaction(
        principal,
        async (client) =>
          client.query<{
            assertion_id: string;
            embedding_dimensions: number;
            vector_dimensions: number;
          }>(
            `SELECT
               assertion_id,
               embedding_dimensions,
               vector_dims(embedding) AS vector_dimensions
             FROM agentic.assertions
             WHERE assertion_id = 'assertion:upgrade'`,
          ),
      );
      assert.deepEqual(migrated.rows[0], {
        assertion_id: "assertion:upgrade",
        embedding_dimensions: 1536,
        vector_dimensions: 1536,
      });
    } finally {
      if (appDatabase) {
        await appDatabase.close();
      }
      if (databaseCreated) {
        await control.query(
          `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
        );
      }
      if (controlConnected) {
        await control.end();
      }
      rmSync(artifactDirectory, { recursive: true, force: true });
    }
  },
);

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
      const migrationConfig = testConfig(
        migrationDatabaseUrl,
        artifactDirectory,
      );
      await migratePostgres(
        migrationConfig,
        undefined,
        configuredEmbeddingSpace(migrationConfig),
      );
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

      await execute(kernel, principalA, "generic-decision", {
        op: "assert",
        assertion: {
          assertionId: "assertion:generic-decision",
          subjectEntityId: "product:1",
          predicate: "rollback_deployment",
          object: { type: "string", value: "api-v42" },
          kind: "decision",
        },
      });
      await execute(kernel, principalA, "generic-policy", {
        op: "assert",
        assertion: {
          assertionId: "assertion:generic-policy",
          subjectEntityId: "product:1",
          predicate: "incident_remediation_policy",
          object: { type: "string", value: "incident-remediation-v2" },
          kind: "directive",
        },
      });
      await execute(kernel, principalA, "generic-support", {
        op: "add_lineage",
        relation: "supports",
        from: {
          type: "assertion",
          assertionId: "assertion:weight",
        },
        to: {
          type: "assertion",
          assertionId: "assertion:generic-decision",
        },
      });
      await assert.rejects(
        () =>
          execute(kernel, principalA, "reserved-order-workflow", {
            op: "create_workflow",
            instanceId: "order:blocked",
            workflowType: "incident_response",
            initialState: "open",
            data: {},
          }),
        /order: identifier namespace is reserved/,
      );
      const competingCreates = await Promise.allSettled([
        execute(kernel, principalA, "generic-create-a", {
          op: "create_workflow",
          instanceId: "incident:concurrent",
          workflowType: "incident_response",
          initialState: "open",
          data: { source: "a" },
        }),
        execute(kernel, principalA, "generic-create-b", {
          op: "create_workflow",
          instanceId: "incident:concurrent",
          workflowType: "incident_response",
          initialState: "open",
          data: { source: "b" },
        }),
      ]);
      assert.equal(
        competingCreates.filter((result) => result.status === "fulfilled")
          .length,
        1,
      );
      const rejectedCreate = competingCreates.find(
        (result) => result.status === "rejected",
      );
      assert.ok(rejectedCreate?.status === "rejected");
      assert.ok(rejectedCreate.reason instanceof KernelError);
      assert.equal(rejectedCreate.reason.code, "conflict");
      await execute(kernel, principalA, "json-workflow", {
        op: "create_workflow",
        instanceId: "incident:json",
        workflowType: "incident_response",
        initialState: "open",
        data: ["alert", 1],
      });
      await execute(kernel, principalA, "json-workflow-advance", {
        op: "advance_workflow",
        instanceId: "incident:json",
        expectedRevision: 1,
        expectedState: "open",
        transitionName: "set_scalar_data",
        toState: "waiting",
        data: "pending",
      });
      const jsonWorkflow = await kernel.getMachineReadOnly(
        principalA,
        "incident:json",
      );
      assert.equal(jsonWorkflow.data, "pending");
      const workflow = await execute(kernel, principalA, "generic-workflow", {
        op: "create_workflow",
        instanceId: "incident:generic",
        workflowType: "incident_response",
        initialState: "investigating",
        data: { severity: 2 },
      });
      assert.equal(jsonField(workflow.result, "revision"), 1);
      await execute(kernel, principalA, "generic-advance", {
        op: "advance_workflow",
        instanceId: "incident:generic",
        expectedRevision: 1,
        expectedState: "investigating",
        transitionName: "authorize_rollback",
        toState: "remediation_pending",
        data: { severity: 2, deployment: "api-v42" },
      });
      await assert.rejects(
        () =>
          execute(kernel, principalA, "generic-missing-status", {
            op: "request_effect",
            instanceId: "incident:generic",
            expectedRevision: 2,
            effectName: "rollback_without_status",
            effectType: "deployment.rollback",
            target: "https://payments.example.com/rollback",
            request: { deployment: "api-v42" },
            idempotencyKey: "rollback-without-status",
            decisionAssertionId: "assertion:generic-decision",
            policyAssertionId: "assertion:generic-policy",
          }),
        /statusUrl is required/,
      );
      await assert.rejects(
          () =>
            execute(kernel, principalA, "generic-invalid-policy", {
              op: "request_effect",
              instanceId: "incident:generic",
              expectedRevision: 2,
              effectName: "rollback_invalid_policy",
              effectType: "deployment.rollback",
              target: "https://payments.example.com/rollback",
              statusUrl: "https://payments.example.com/status/invalid_policy",
              request: { deployment: "api-v42" },
              idempotencyKey: "rollback-invalid-policy",
              decisionAssertionId: "assertion:generic-decision",
              policyAssertionId: "assertion:generic-decision",
            }),
          /directive assertion/,
      );
      const genericEffectResult = await execute(
        kernel,
        principalA,
        "generic-effect",
        {
          op: "request_effect",
          instanceId: "incident:generic",
          expectedRevision: 2,
          effectName: "rollback_api",
          effectType: "deployment.rollback",
          target: "https://payments.example.com/rollback",
          statusUrl: "https://payments.example.com/status/rollback_api",
          request: { deployment: "api-v42" },
          idempotencyKey: "rollback-api-v42",
          decisionAssertionId: "assertion:generic-decision",
          policyAssertionId: "assertion:generic-policy",
          budgetAmount: "25",
          currency: "USD",
        },
      );
      const genericEffectId = field(
        genericEffectResult.result,
        "effectId",
      );
      assert.equal(
        field(genericEffectResult.result, "outcomeHandler"),
        "none",
      );
      const genericEffectReplay = await execute(
        kernel,
        principalA,
        "generic-effect-retry",
        {
          op: "request_effect",
          instanceId: "incident:generic",
          expectedRevision: 2,
          effectName: "rollback_api",
          effectType: "deployment.rollback",
          target: "https://payments.example.com/rollback",
          statusUrl: "https://payments.example.com/status/rollback_api",
          request: { deployment: "api-v42" },
          idempotencyKey: "rollback-api-v42",
          decisionAssertionId: "assertion:generic-decision",
          policyAssertionId: "assertion:generic-policy",
          budgetAmount: "25",
          currency: "USD",
        },
      );
      assert.equal(
        field(genericEffectReplay.result, "effectId"),
        genericEffectId,
      );
      await assert.rejects(
        () =>
          execute(kernel, principalA, "generic-effect-conflict", {
            op: "request_effect",
            instanceId: "incident:generic",
            expectedRevision: 2,
            effectName: "rollback_api_changed",
            effectType: "deployment.rollback",
            target: "https://payments.example.com/other-path",
            statusUrl: "https://payments.example.com/status/rollback_changed",
            request: { deployment: "api-v99" },
            idempotencyKey: "rollback-api-v42",
            decisionAssertionId: "assertion:generic-decision",
            policyAssertionId: "assertion:generic-policy",
            budgetAmount: "25",
            currency: "USD",
          }),
        /Provider idempotency key .* different effect request/,
      );
      await assert.rejects(
        () =>
          execute(kernel, principalA, "forged-generic-outcome", {
            op: "record_effect_outcome",
            effectId: genericEffectId,
            idempotencyKey: "forged-generic-outcome",
            status: "succeeded",
          }),
        /accepted only from the effect worker/,
      );
      const reservedBudget = await database.query<{
        reserved: string;
        spent: string;
      }>(
        `SELECT
           effect_budget_reserved::TEXT AS reserved,
           effect_budget_spent::TEXT AS spent
         FROM agentic_auth.api_keys
         WHERE key_id = $1`,
        [principalA.keyId],
      );
      assert.deepEqual(reservedBudget.rows[0], {
        reserved: "25.0000",
        spent: "0.0000",
      });
      let genericDeliveries = 0;
      const genericWorker = new EffectWorker(
        database,
        {
          deliver: async () => {
            genericDeliveries += 1;
            return {
              status: "succeeded",
              responseStatus: 200,
              outcome: { providerReference: "rollback-42" },
            };
          },
          reconcile: async () => ({
            status: "unknown",
            responseStatus: 200,
            outcome: { status: "pending" },
          }),
        },
        { effectLeaseSeconds: 30, effectMaxAttempts: 3 },
        metrics,
        logger,
      );
      assert.equal(await genericWorker.runOnce(), true);
      assert.equal(genericDeliveries, 1);
      const genericEffects = await execute(
        kernel,
        principalA,
        "generic-effects",
        {
          op: "list_effects",
          instanceId: "incident:generic",
        },
      );
      const genericEffect = arrayItem(genericEffects.result, 0);
      assert.equal(field(genericEffect, "status"), "succeeded");
      const genericMachine = await kernel.getMachineReadOnly(
        principalA,
        "incident:generic",
      );
      assert.equal(genericMachine.state, "remediation_pending");
      assert.equal(genericMachine.revision, 2);
      const settledBudget = await database.query<{
        reserved: string;
        spent: string;
      }>(
        `SELECT
           effect_budget_reserved::TEXT AS reserved,
           effect_budget_spent::TEXT AS spent
         FROM agentic_auth.api_keys
         WHERE key_id = $1`,
        [principalA.keyId],
      );
      assert.deepEqual(settledBudget.rows[0], {
        reserved: "0.0000",
        spent: "25.0000",
      });
      const lineage = await database.withTenantTransaction(
        principalA,
        (client) =>
          client.query<{ relation: string }>(
            `SELECT relation
             FROM agentic.lineage_edges
             WHERE to_effect_id = $1
             ORDER BY relation`,
            [genericEffectId],
          ),
      );
      assert.deepEqual(
        lineage.rows.map((edge) => edge.relation),
        ["authorizes", "governs", "produces"],
      );
      const hiddenLineage = await database.withTenantTransaction(
        principalB,
        (client) =>
          client.query(
            `SELECT 1
             FROM agentic.lineage_edges
             WHERE to_effect_id = $1`,
            [genericEffectId],
          ),
      );
      assert.equal(hiddenLineage.rowCount, 0);
      await assert.rejects(
        () =>
          execute(kernel, principalB, "cross-tenant-lineage", {
            op: "add_lineage",
            relation: "authorizes",
            from: {
              type: "assertion",
              assertionId: "assertion:generic-decision",
            },
            to: { type: "effect", effectId: genericEffectId },
          }),
        /endpoint was not found/,
      );
      const reconcilingEffectResult = await execute(
          kernel,
          principalA,
          "generic-reconciling-effect",
          {
            op: "request_effect",
            instanceId: "incident:generic",
            expectedRevision: 2,
            effectName: "rollback_api_reconcile",
            effectType: "deployment.rollback",
            target: "https://payments.example.com/rollback",
            statusUrl: "https://payments.example.com/status/rollback_reconcile",
            request: { deployment: "api-v43" },
            idempotencyKey: "rollback-api-v43",
            decisionAssertionId: "assertion:generic-decision",
            policyAssertionId: "assertion:generic-policy",
            budgetAmount: "10",
            currency: "USD",
          },
      );
      const reconcilingEffectId = field(
          reconcilingEffectResult.result,
          "effectId",
      );
      let genericDeliveryCalls = 0;
      let genericReconciliationCalls = 0;
      const reconcilingGenericWorker = new EffectWorker(
          database,
          {
            deliver: async () => {
              genericDeliveryCalls += 1;
              return {
                status: "unknown",
                responseStatus: null,
                outcome: ["timeout", 1],
              };
            },
            reconcile: async () => {
              genericReconciliationCalls += 1;
              return {
                status: "succeeded",
                responseStatus: 200,
                outcome: "completed",
              };
            },
          },
          { effectLeaseSeconds: 30, effectMaxAttempts: 1 },
          metrics,
          logger,
      );
      assert.equal(await reconcilingGenericWorker.runOnce(), true);
      await database.withTenantTransaction(principalA, (client) =>
          client.query(
            `UPDATE agentic.effect_intents
             SET next_attempt_at = clock_timestamp()
             WHERE effect_id = $1`,
            [reconcilingEffectId],
          ),
      );
      assert.equal(await reconcilingGenericWorker.runOnce(), true);
      assert.equal(genericDeliveryCalls, 1);
      assert.equal(genericReconciliationCalls, 1);
      const reconciledGenericEffects = await execute(
          kernel,
          principalA,
          "generic-reconciled-effects",
          {
            op: "list_effects",
            instanceId: "incident:generic",
          },
      );
      const reconciledEffect = findArrayItemByField(
          reconciledGenericEffects.result,
          "effectId",
          reconcilingEffectId,
      );
      assert.equal(field(reconciledEffect, "status"), "succeeded");
      const reconciledBudget = await database.query<{
          reserved: string;
          spent: string;
      }>(
          `SELECT
             effect_budget_reserved::TEXT AS reserved,
             effect_budget_spent::TEXT AS spent
           FROM agentic_auth.api_keys
           WHERE key_id = $1`,
          [principalA.keyId],
      );
      assert.deepEqual(reconciledBudget.rows[0], {
          reserved: "0.0000",
          spent: "35.0000",
      });
      const revocableKey = await createApiKey(database, config, {
          tenantId: tenantA,
          tenantName: "Tenant A",
          principalId: "revocable-agent",
          scopes: ["data:read", "effects:write"],
          purposes: ["test"],
          effectBudgetCurrency: "USD",
          effectBudgetLimit: "10",
      });
      const revocablePrincipal = await authenticateToken(
          database,
          config,
          revocableKey.token,
          "test",
      );
      const cancellableEffectResult = await execute(
          kernel,
          revocablePrincipal,
          "generic-cancellable-effect",
          {
            op: "request_effect",
            instanceId: "incident:generic",
            expectedRevision: 2,
            effectName: "rollback_api_cancelled",
            effectType: "deployment.rollback",
            target: "https://payments.example.com/rollback",
            statusUrl: "https://payments.example.com/status/rollback_cancelled",
            request: { deployment: "api-v44" },
            idempotencyKey: "rollback-api-v44",
            decisionAssertionId: "assertion:generic-decision",
            policyAssertionId: "assertion:generic-policy",
            budgetAmount: "5",
            currency: "USD",
          },
      );
      const cancellableEffectId = field(
          cancellableEffectResult.result,
          "effectId",
      );
      await database.withSystemWriteTransaction((client) =>
        revokeApiKey(client, revocableKey.keyId),
      );
      let cancelledDeliveryCalls = 0;
      const cancellationWorker = new EffectWorker(
          database,
          {
            deliver: async () => {
              cancelledDeliveryCalls += 1;
              return {
                status: "succeeded",
                responseStatus: 200,
                outcome: { providerReference: "unexpected" },
              };
            },
            reconcile: async () => ({
              status: "unknown",
              responseStatus: 200,
              outcome: { status: "pending" },
            }),
          },
          { effectLeaseSeconds: 30, effectMaxAttempts: 3 },
          metrics,
          logger,
      );
      assert.equal(await cancellationWorker.runOnce(), false);
      assert.equal(cancelledDeliveryCalls, 0);
      const cancelledEffect = await database.withTenantTransaction(
          principalA,
          async (client) =>
            client.query<{ status: string }>(
              `SELECT status
               FROM agentic.effect_intents
               WHERE effect_id = $1`,
              [cancellableEffectId],
            ),
      );
      assert.equal(cancelledEffect.rows[0]?.status, "cancelled");
      const cancelledBudget = await database.query<{
          reserved: string;
          spent: string;
      }>(
          `SELECT
             effect_budget_reserved::TEXT AS reserved,
             effect_budget_spent::TEXT AS spent
           FROM agentic_auth.api_keys
           WHERE key_id = $1`,
          [revocableKey.keyId],
      );
      assert.deepEqual(cancelledBudget.rows[0], {
          reserved: "0.0000",
          spent: "0.0000",
      });

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
      await assert.rejects(
        () =>
          execute(kernel, principalA, "forge-retail-transition", {
            op: "advance_workflow",
            instanceId: "order:order-1",
            expectedRevision: 1,
            expectedState: "reserved",
            transitionName: "forge_confirmation",
            toState: "confirmed",
            data: {},
            terminal: true,
          }),
        /cannot modify retail orders/,
      );
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
      assert.equal(Number(budget.rows[0]?.effect_budget_spent), 55);

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

test(
  "embedding dimensions are configurable and use bounded HNSW candidates",
  { skip: !databaseUrl || !migrationDatabaseUrl },
  async () => {
    assert.ok(databaseUrl);
    assert.ok(migrationDatabaseUrl);
    const databaseName = `agentic_embedding_${randomUUID().replaceAll("-", "")}`;
    const artifactDirectory = mkdtempSync(
      join(tmpdir(), "agentic-data-embedding-space-"),
    );
    const controlUrl = databaseUrlFor(migrationDatabaseUrl, "postgres");
    const adminUrl = databaseUrlFor(migrationDatabaseUrl, databaseName);
    const appUrl = databaseUrlFor(databaseUrl, databaseName);
    const control = new PgClient({ connectionString: controlUrl });
    let database: ProductionDatabase | null = null;
    let controlConnected = false;
    let databaseCreated = false;
    try {
      await control.connect();
      controlConnected = true;
      await control.query(`CREATE DATABASE ${databaseName}`);
      databaseCreated = true;
      const config = testConfig(appUrl, artifactDirectory, {
        dimensions: 768,
        model: "test-embedding-768",
        version: "1",
      });
      config.searchCandidateLimit = 20;
      await migratePostgres(
        testConfig(adminUrl, artifactDirectory, {
          dimensions: 768,
          model: "test-embedding-768",
          version: "1",
        }),
        undefined,
        configuredEmbeddingSpace(config),
      );
      database = new ProductionDatabase(config);
      const activeDatabase = database;
      await assertEmbeddingSpaceConfigured(
        activeDatabase,
        configuredEmbeddingSpace(config),
      );
      const status = await embeddingSpaceStatus(
        activeDatabase,
        configuredEmbeddingSpace(config),
      );
      assert.equal(status.ready, true);
      assert.equal(status.actual?.dimensions, 768);
      assert.equal(
        embeddingIndexName(768),
        "assertions_embedding_hnsw_768",
      );
      const mismatchStatus = await embeddingSpaceStatus(activeDatabase, {
        dimensions: 384,
        model: "test-embedding-384",
        version: "1",
      });
      assert.equal(mismatchStatus.ready, false);
      await assert.rejects(
        () =>
          assertEmbeddingSpaceConfigured(activeDatabase, {
            dimensions: 384,
            model: "test-embedding-384",
            version: "1",
          }),
        /does not match database embedding space/,
      );
      await assert.rejects(
        () =>
          activeDatabase.query(
            `UPDATE agentic.embedding_configuration
             SET dimensions = 384
             WHERE singleton = TRUE`,
          ),
        /permission denied/,
      );

      const provider = new ScenarioEmbeddingProvider(
        768,
        "test-embedding-768",
        "1",
      );
      const artifactStore = new EncryptedArtifactStore(
        artifactDirectory,
        config.artifactKeyring,
      );
      const metrics = new MetricsRegistry();
      const logger = createLogger(config);
      const kernel = new ProductionKernel(
        activeDatabase,
        artifactStore,
        provider,
        config,
        metrics,
        logger,
      );
      const key = await createApiKey(activeDatabase, config, {
        tenantId: "embedding-tenant",
        tenantName: "Embedding Tenant",
        principalId: "embedding-agent",
        scopes: ["data:read", "data:write"],
        purposes: ["test"],
        effectBudgetCurrency: "USD",
        effectBudgetLimit: "0",
      });
      const principal = await authenticateToken(
        activeDatabase,
        config,
        key.token,
        "test",
      );
      await execute(kernel, principal, "embedding-entity", {
        op: "put_entity",
        entity: {
          entityId: "product:embedding",
          entityType: "product",
          canonicalName: "Configurable Embedding Product",
        },
      });
      const writer = await activeDatabase.pool.connect();
      const migrationDatabase = new ProductionDatabase(
        testConfig(adminUrl, artifactDirectory, {
          dimensions: 768,
          model: "test-embedding-768",
          version: "1",
        }),
      );
      let writerTransactionOpen = false;
      try {
        await writer.query("BEGIN");
        writerTransactionOpen = true;
        await writer.query(
          `SELECT
             set_config('app.tenant_id', $1, TRUE),
             set_config('app.principal_id', $2, TRUE),
             set_config('app.key_id', $3, TRUE),
             set_config('app.purpose', $4, TRUE)`,
          [
            principal.tenantId,
            principal.principalId,
            principal.keyId,
            principal.purpose,
          ],
        );
        await writer.query(
          `INSERT INTO agentic.assertions (
             tenant_id, assertion_id, subject_entity_id, predicate,
             object_type, object_json, object_key, kind, perspective,
             valid_from, strength_type, strength_json, authority, status,
             search_text, embedding, embedding_model, embedding_version,
             created_by
           ) VALUES (
             $1, 'assertion:configuration-race', 'product:embedding',
             'configuration_race', 'string', $2, $3, 'reported_fact',
             'organization', clock_timestamp(), 'none', $4, 50, 'active',
             'configuration race', $5::vector, $6, $7, $8
           )`,
          [
            principal.tenantId,
            { type: "string", value: "configuration race" },
            JSON.stringify({ type: "string", value: "configuration race" }),
            { type: "none" },
            vectorToSql(vector(0, 768)),
            provider.model,
            provider.version,
            principal.principalId,
          ],
        );
        let reconfigurationFinished = false;
        const reconfiguration = configureEmbeddingSpace(
          migrationDatabase,
          {
            dimensions: 384,
            model: "test-embedding-384",
            version: "1",
          },
        )
          .then(
            () => ({ error: null }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            reconfigurationFinished = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(reconfigurationFinished, false);
        await writer.query("COMMIT");
        writerTransactionOpen = false;
        const reconfigurationResult = await reconfiguration;
        assert.ok(reconfigurationResult.error instanceof Error);
        assert.match(
          reconfigurationResult.error.message,
          /cannot change while assertions exist/,
        );
      } finally {
        if (writerTransactionOpen) {
          await writer.query("ROLLBACK");
        }
        writer.release();
        await migrationDatabase.close();
      }
      await execute(kernel, principal, "embedding-assertion", {
        op: "assert",
        assertion: {
          assertionId: "assertion:embedding",
          subjectEntityId: "product:embedding",
          predicate: "description",
          object: { type: "string", value: "configurable dimensions" },
          kind: "reported_fact",
        },
      });
      await assert.rejects(
        () =>
          activeDatabase.withTenantTransaction(
            principal,
            async (client) =>
              client.query(
                `UPDATE agentic.assertions
                 SET embedding = $1::vector
                 WHERE assertion_id = 'assertion:embedding'`,
                [vectorToSql(Array.from({ length: 768 }, () => 0))],
              ),
          ),
        /assertions_embedding_dimensions/,
      );
      const search = await kernel.searchReadOnly(principal, {
        op: "search",
        text: "configurable dimensions",
      });
      assert.equal(
        search[0]?.assertion.assertionId,
        "assertion:embedding",
      );

      await execute(kernel, principal, "history-entity", {
        op: "put_entity",
        entity: {
          entityId: "product:history",
          entityType: "product",
          canonicalName: "Historical Product",
        },
      });
      let supersededAssertionId: string | undefined;
      for (let index = 0; index < 25; index += 1) {
        const assertionId = `assertion:stale:${index}`;
        await execute(kernel, principal, `stale-assertion-${index}`, {
          op: "assert",
          assertion: {
            assertionId,
            subjectEntityId: "product:history",
            predicate: "history_value",
            object: { type: "string", value: `stale-value-${index}` },
            kind: "reported_fact",
            ...(supersededAssertionId
              ? { supersedesAssertionId: supersededAssertionId }
              : {}),
          },
        });
        supersededAssertionId = assertionId;
      }
      await execute(kernel, principal, "current-assertion", {
        op: "assert",
        assertion: {
          assertionId: "assertion:current",
          subjectEntityId: "product:history",
          predicate: "history_value",
          object: { type: "string", value: "current-value" },
          kind: "reported_fact",
          supersedesAssertionId: supersededAssertionId,
        },
      });
      const currentSearch = await kernel.searchReadOnly(principal, {
        op: "search",
        text: "vector-only-query",
        predicate: "history_value",
        limit: 1,
      });
      assert.equal(
        currentSearch[0]?.assertion.assertionId,
        "assertion:current",
      );

      await execute(kernel, principal, "graph-root", {
        op: "put_entity",
        entity: {
          entityId: "graph:root",
          entityType: "service",
          canonicalName: "Graph Root",
        },
      });
      await execute(kernel, principal, "graph-target", {
        op: "put_entity",
        entity: {
          entityId: "graph:target",
          entityType: "service",
          canonicalName: "Graph Target",
        },
      });
      await execute(kernel, principal, "graph-edge", {
        op: "assert",
        assertion: {
          assertionId: "assertion:graph-edge",
          subjectEntityId: "graph:root",
          predicate: "related_to",
          object: { type: "entity", value: "graph:target" },
          kind: "reported_fact",
        },
      });
      await execute(kernel, principal, "graph-target-value", {
        op: "assert",
        assertion: {
          assertionId: "assertion:graph-target",
          subjectEntityId: "graph:target",
          predicate: "graph_value",
          object: { type: "string", value: "reachable-value" },
          kind: "reported_fact",
        },
      });
      for (let index = 0; index < 25; index += 1) {
        const entityId = `graph:unrelated:${index}`;
        await execute(kernel, principal, `unrelated-entity-${index}`, {
          op: "put_entity",
          entity: {
            entityId,
            entityType: "service",
            canonicalName: `Unrelated Service ${index}`,
          },
        });
        await execute(kernel, principal, `unrelated-assertion-${index}`, {
          op: "assert",
          assertion: {
            assertionId: `assertion:unrelated:${index}`,
            subjectEntityId: entityId,
            predicate: "graph_value",
            object: { type: "string", value: `unrelated-value-${index}` },
            kind: "reported_fact",
          },
        });
      }
      const graphSearch = await kernel.searchReadOnly(principal, {
        op: "search",
        text: "vector-only-query",
        predicate: "graph_value",
        relatedToEntityId: "graph:root",
        maxGraphDepth: 2,
        limit: 1,
      });
      assert.equal(
        graphSearch[0]?.assertion.assertionId,
        "assertion:graph-target",
      );

      await execute(kernel, principal, "tenant-target-entity", {
        op: "put_entity",
        entity: {
          entityId: "tenant:target",
          entityType: "service",
          canonicalName: "Tenant Target",
        },
      });
      await execute(kernel, principal, "tenant-target-assertion", {
        op: "assert",
        assertion: {
          assertionId: "assertion:tenant-target",
          subjectEntityId: "tenant:target",
          predicate: "tenant_value",
          object: { type: "string", value: "current-value" },
          kind: "reported_fact",
        },
      });
      const otherKey = await createApiKey(activeDatabase, config, {
        tenantId: "embedding-other-tenant",
        tenantName: "Other Embedding Tenant",
        principalId: "other-embedding-agent",
        scopes: ["data:read", "data:write"],
        purposes: ["test"],
        effectBudgetCurrency: "USD",
        effectBudgetLimit: "0",
      });
      const otherPrincipal = await authenticateToken(
        activeDatabase,
        config,
        otherKey.token,
        "test",
      );
      for (let index = 0; index < 25; index += 1) {
        const entityId = `tenant:other:${index}`;
        await execute(kernel, otherPrincipal, `other-entity-${index}`, {
          op: "put_entity",
          entity: {
            entityId,
            entityType: "service",
            canonicalName: `Other Tenant Service ${index}`,
          },
        });
        await execute(
          kernel,
          otherPrincipal,
          `other-assertion-${index}`,
          {
            op: "assert",
            assertion: {
              assertionId: `assertion:other:${index}`,
              subjectEntityId: entityId,
              predicate: "tenant_value",
              object: { type: "string", value: `other-value-${index}` },
              kind: "reported_fact",
            },
          },
        );
      }
      const tenantSearch = await kernel.searchReadOnly(principal, {
        op: "search",
        text: "vector-only-query",
        predicate: "tenant_value",
        limit: 1,
      });
      assert.equal(
        tenantSearch[0]?.assertion.assertionId,
        "assertion:tenant-target",
      );

      const query = buildHybridSearchQuery({
        ...configuredEmbeddingSpace(config),
        embedding: vector(1, 768),
        operation: {
          op: "search",
          text: "configurable dimensions",
        },
        systemAt: new Date().toISOString(),
        validAt: new Date().toISOString(),
        candidateLimit: 20,
        resultLimit: 10,
      });
      const plan = await activeDatabase.withTenantTransaction(
        principal,
        async (client) => {
          await client.query("SET LOCAL enable_seqscan = off");
          const result = await client.query<{ "QUERY PLAN": string }>(
            `EXPLAIN (COSTS OFF) ${query.text}`,
            query.values,
          );
          return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
        },
      );
      assert.match(plan, /assertions_embedding_hnsw_768/);

      await assert.rejects(
        () =>
          migratePostgres(
            testConfig(adminUrl, artifactDirectory, {
              dimensions: 384,
              model: "test-embedding-384",
              version: "1",
            }),
            undefined,
            {
              dimensions: 384,
              model: "test-embedding-384",
              version: "1",
            },
          ),
        /cannot change while assertions exist/,
      );
      await cleanupTenant(activeDatabase, principal);
      await cleanupTenant(activeDatabase, otherPrincipal);
      await activeDatabase.withSystemTransaction(async (client) => {
        await client.query(
          "DELETE FROM agentic_auth.api_keys WHERE tenant_id = ANY($1)",
          [[principal.tenantId, otherPrincipal.tenantId]],
        );
        await client.query(
          "DELETE FROM agentic_auth.tenants WHERE tenant_id = ANY($1)",
          [[principal.tenantId, otherPrincipal.tenantId]],
        );
      });
    } finally {
      if (database) {
        await database.close();
      }
      if (databaseCreated) {
        await control.query(
          `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
        );
      }
      if (controlConnected) {
        await control.end();
      }
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
      "weights-2",
    );
    const embeddings = await provider.embed(["one", "two"]);
    assert.equal(embeddings.length, 2);
    assert.equal(embeddings[0]?.length, 1536);
    assert.equal(provider.version, "weights-2");
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
  public longestInput = 0;

  public constructor(
    public readonly dimensions = 1536,
    public readonly model = "test-embedding",
    public readonly version = "1",
  ) {}

  public async embed(texts: string[]): Promise<number[][]> {
    this.longestInput = Math.max(
      this.longestInput,
      ...texts.map((text) => text.length),
    );
    return texts.map((text) =>
      vector(text.length || 1, this.dimensions),
    );
  }
}

class ScenarioEmbeddingProvider extends TestEmbeddingProvider {
  public override async embed(texts: string[]): Promise<number[][]> {
    this.longestInput = Math.max(
      this.longestInput,
      ...texts.map((text) => text.length),
    );
    return texts.map((text) => {
      if (
        text.includes("current-value") ||
        text.includes("reachable-value")
      ) {
        const result = vector(0, this.dimensions);
        result[0] = 0.8;
        result[1] = 0.6;
        return result;
      }
      return vector(0, this.dimensions);
    });
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

function vector(seed: number, dimensions = 1536): number[] {
  const result = Array.from({ length: dimensions }, () => 0);
  result[seed % result.length] = 1;
  return result;
}

function testConfig(
  url: string,
  artifactDirectory: string,
  embedding: {
    model: string;
    version: string;
    dimensions: number;
  } = {
    model: "test-embedding",
    version: "1",
    dimensions: 1536,
  },
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
    embeddingModel: embedding.model,
    embeddingVersion: embedding.version,
    embeddingDimensions: embedding.dimensions,
    embeddingTimeoutMs: 5_000,
    searchCandidateLimit: 200,
    hnswEfSearch: 100,
    hnswMaxScanTuples: 20_000,
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

function jsonField(value: JsonValue, name: string): JsonValue {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    !(name in value)
  ) {
    throw new Error(`Expected ${name}`);
  }
  return value[name] ?? null;
}

function arrayItem(value: JsonValue, index: number): JsonValue {
  if (!Array.isArray(value) || value[index] === undefined) {
    throw new Error(`Expected array item ${index}`);
  }
  return value[index];
}

function findArrayItemByField(
  value: JsonValue,
  fieldName: string,
  expected: JsonValue,
): JsonValue {
  if (!Array.isArray(value)) {
    throw new Error("Expected an array");
  }
  const match = value.find(
    (candidate) =>
      candidate !== null &&
      !Array.isArray(candidate) &&
      typeof candidate === "object" &&
      candidate[fieldName] === expected,
  );
  if (match === undefined) {
    throw new Error(`Expected array item with ${fieldName}`);
  }
  return match;
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

function databaseUrlFor(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
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
    const ready = await fetch(`${base}/health/ready`);
    assert.equal(ready.status, 200);
    const unauthorized = await fetch(`${base}/v1/catalog`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${base}/v1/catalog`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-agent-purpose": "test",
      },
    });
    assert.equal(authorized.status, 200);
    const catalog = await authorized.json() as {
      embeddingSpace?: {
        model: string;
        version: string;
        dimensions: number;
      };
    };
    assert.deepEqual(catalog.embeddingSpace, {
      model: config.embeddingModel,
      version: config.embeddingVersion,
      dimensions: config.embeddingDimensions,
    });
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
      "lineage_edges",
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
    assert.ok(tools.tools.some((tool) => tool.name === "explain_trace"));
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
