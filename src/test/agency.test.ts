import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  formatTraceExplanation,
  traceEndpointKey,
} from "../explain.js";
import { executeIntent } from "../ir.js";
import { AgenticKernel, KernelError } from "../kernel.js";
import { SqliteStore } from "../store.js";
import type { PrincipalContext } from "../types.js";

const principal: PrincipalContext = {
  tenantId: "agency-tenant",
  principalId: "sre-agent",
  purpose: "incident-response",
};

test("effect listing preserves legacy unbounded reads and supports pagination", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  const timestamp = "2026-01-01T00:00:00.000Z";
  try {
    store.run(
      `INSERT INTO machine_instances (
         tenant_id, instance_id, machine_type, state, data_json, revision,
         terminal, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      principal.tenantId,
      "incident:pagination",
      "incident_response",
      "ready",
      "{}",
      1,
      0,
      timestamp,
      timestamp,
    );
    store.run(
      `INSERT INTO machine_history (
         tenant_id, instance_id, revision, event_id, transition_name,
         prior_state, new_state, data_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      principal.tenantId,
      "incident:pagination",
      1,
      "event:pagination",
      "create",
      "none",
      "ready",
      "{}",
      timestamp,
    );
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, "0");
      store.run(
        `INSERT INTO effect_intents (
           tenant_id, effect_id, instance_id, originating_revision,
           effect_name, effect_type, outcome_handler, target, status_url,
           request_json, idempotency_key, status, attempt_count,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        principal.tenantId,
        `effect:${suffix}`,
        "incident:pagination",
        1,
        `effect_${suffix}`,
        "test.effect",
        "none",
        "https://effects.example.com/apply",
        "https://effects.example.com/status",
        "{}",
        `effect-key-${suffix}`,
        "planned",
        0,
        timestamp,
        timestamp,
      );
    }

    assert.equal(
      kernel.listEffects(principal.tenantId, "incident:pagination").length,
      101,
    );
    const firstPage = kernel.listEffects(
      principal.tenantId,
      "incident:pagination",
      { limit: 100 },
    );
    assert.equal(firstPage.length, 100);
    const cursor = firstPage[99]?.effectId;
    assert.ok(cursor);
    const secondPage = kernel.listEffects(
      principal.tenantId,
      "incident:pagination",
      {
        afterEffectId: cursor,
        limit: 100,
      },
    );
    assert.equal(secondPage.length, 1);
    assert.equal(secondPage[0]?.effectId, "effect:100");
  } finally {
    store.close();
  }
});

test("generic workflows, effects, and lineage preserve agency history", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  try {
    kernel.putEntity(principal, {
      entityId: "service:api",
      entityType: "service",
      canonicalName: "API Service",
    });

    kernel.putArtifact(principal, {
      artifactId: "artifact:alert",
      mediaType: "application/json",
      content: "{\"errorRate\":0.42}",
      sourceIdentity: "monitoring",
    });
    kernel.assert(principal, {
      assertionId: "assertion:observation",
      subjectEntityId: "service:api",
      predicate: "error_rate_elevated",
      object: { type: "boolean", value: true },
      kind: "observation",
      sourceArtifactId: "artifact:alert",
    });
    kernel.assert(principal, {
      assertionId: "assertion:hypothesis",
      subjectEntityId: "service:api",
      predicate: "deployment_caused_regression",
      object: { type: "boolean", value: true },
      kind: "hypothesis",
    });
    kernel.assert(principal, {
      assertionId: "assertion:decision",
      subjectEntityId: "service:api",
      predicate: "rollback_deployment",
      object: { type: "string", value: "api-v42" },
      kind: "decision",
    });
    kernel.assert(principal, {
      assertionId: "assertion:policy",
      subjectEntityId: "service:api",
      predicate: "incident_remediation_policy",
      object: { type: "string", value: "incident-remediation-v2" },
      kind: "directive",
    });
    kernel.addLineage(principal, {
      relation: "supports",
      from: { type: "assertion", assertionId: "assertion:observation" },
      to: { type: "assertion", assertionId: "assertion:hypothesis" },
    });
    kernel.addLineage(principal, {
      relation: "supports",
      from: { type: "assertion", assertionId: "assertion:hypothesis" },
      to: { type: "assertion", assertionId: "assertion:decision" },
    });

    const created = kernel.createWorkflow(principal, {
      instanceId: "incident:1001",
      workflowType: "incident_response",
      initialState: "investigating",
      data: { severity: 2 },
    });
    assert.equal(created.revision, 1);
    assert.equal(created.terminal, false);

    const advanced = kernel.advanceWorkflow(principal, {
      instanceId: created.instanceId,
      expectedRevision: 1,
      expectedState: "investigating",
      transitionName: "authorize_rollback",
      toState: "remediation_pending",
      data: { severity: 2, deployment: "api-v42" },
    });
    assert.equal(advanced.revision, 2);

    const effectRequest = {
      instanceId: created.instanceId,
      expectedRevision: 2,
      effectName: "rollback_api",
      effectType: "deployment.rollback",
      target: "https://deployments.example.com/rollback",
      statusUrl: "https://deployments.example.com/status/rollback-api",
      request: { deployment: "api-v42" },
      idempotencyKey: "rollback-api-v42",
      decisionAssertionId: "assertion:decision",
      policyAssertionId: "assertion:policy",
    };
    const effect = kernel.requestEffect(principal, effectRequest);
    assert.deepEqual(
      kernel.requestEffect(principal, effectRequest),
      effect,
    );
    assert.equal(effect.outcomeHandler, "none");
    assert.equal(effect.decisionAssertionId, "assertion:decision");
    assert.equal(effect.policyAssertionId, "assertion:policy");

    const unknown = kernel.recordEffectOutcome(principal, {
      effectId: effect.effectId,
      idempotencyKey: "rollback-attempt-1",
      status: "unknown",
      outcome: { reason: "timeout" },
    });
    assert.equal(unknown.status, "unknown");
    assert.deepEqual(
      kernel.recordEffectOutcome(principal, {
        effectId: effect.effectId,
        idempotencyKey: "rollback-attempt-1",
        status: "unknown",
        outcome: { reason: "timeout" },
      }),
      unknown,
    );
    const succeeded = kernel.recordEffectOutcome(principal, {
      effectId: effect.effectId,
      idempotencyKey: "rollback-attempt-2",
      status: "succeeded",
      outcome: { providerReference: "deploy-rollback-42" },
    });
    assert.equal(succeeded.status, "succeeded");

    const unchanged = kernel.getWorkflow(
      principal.tenantId,
      created.instanceId,
    );
    assert.equal(unchanged.state, "remediation_pending");
    assert.equal(unchanged.revision, 2);

    kernel.assert(principal, {
      assertionId: "assertion:verification",
      subjectEntityId: "service:api",
      predicate: "error_rate_returned_to_baseline",
      object: { type: "boolean", value: true },
      kind: "observation",
    });
    const verification = kernel.addLineage(principal, {
      relation: "verifies",
      from: { type: "effect", effectId: effect.effectId },
      to: { type: "assertion", assertionId: "assertion:verification" },
    });
    assert.equal(verification.relation, "verifies");

    const lineage = store.all<{ relation: string }>(
      `SELECT relation FROM lineage_edges
       WHERE tenant_id = ?
       ORDER BY relation`,
      principal.tenantId,
    );
    assert.deepEqual(
      lineage.map((edge) => edge.relation),
      [
        "authorizes",
        "evidence_for",
        "governs",
        "produces",
        "supports",
        "supports",
        "verifies",
      ],
    );
    const explanation = kernel.explain(
      principal.tenantId,
      { type: "effect", effectId: effect.effectId },
      4,
    );
    assert.ok(explanation.nodes.length >= 7);
    assert.ok(explanation.edges.length >= 7);
    const formatted = formatTraceExplanation(explanation);
    assert.match(formatted, /deployment\.rollback effect succeeded/);
    assert.match(formatted, /attempt 1: unknown/);
    assert.match(formatted, /attempt 2: succeeded/);
    const artifactNode = explanation.nodes.find(
      (node) =>
        node.ref.type === "artifact" &&
        node.ref.artifactId === "artifact:alert",
    );
    assert.ok(artifactNode);
    assert.equal(
      artifactNode.record !== null &&
        !Array.isArray(artifactNode.record) &&
        typeof artifactNode.record === "object" &&
        "content" in artifactNode.record,
      false,
    );
    assert.equal(
      kernel.explain(
        principal.tenantId,
        { type: "effect", effectId: effect.effectId },
        0,
      ).nodes.length,
      1,
    );
    for (let attempt = 3; attempt <= 25; attempt += 1) {
      store.run(
        `INSERT INTO effect_attempts (
           tenant_id, effect_id, attempt_number, status, outcome_json,
           created_at
         ) VALUES (?, ?, ?, 'unknown', ?, ?)`,
        principal.tenantId,
        effect.effectId,
        attempt,
        JSON.stringify({ detail: "x".repeat(2_000) }),
        new Date(2026, 0, 1, 0, 0, attempt).toISOString(),
      );
    }
    const boundedAttempts = kernel.explain(
      principal.tenantId,
      { type: "effect", effectId: effect.effectId },
      0,
    );
    assert.equal(boundedAttempts.truncated, true);
    const effectRecord = boundedAttempts.nodes[0]?.record;
    assert.ok(
      effectRecord !== null &&
        !Array.isArray(effectRecord) &&
        typeof effectRecord === "object",
    );
    assert.equal(effectRecord.attemptCount, 25);
    assert.ok(Array.isArray(effectRecord.attempts));
    assert.equal(effectRecord.attempts.length, 20);

    assert.throws(
      () =>
        kernel.advanceWorkflow(principal, {
          instanceId: created.instanceId,
          expectedRevision: 1,
          expectedState: "investigating",
          transitionName: "stale_transition",
          toState: "failed",
          data: {},
        }),
      conflict("changed before"),
    );
    const terminal = kernel.advanceWorkflow(principal, {
      instanceId: created.instanceId,
      expectedRevision: 2,
      expectedState: "remediation_pending",
      transitionName: "verify_remediation",
      toState: "resolved",
      data: { verified: true },
      terminal: true,
    });
    assert.equal(terminal.terminal, true);
    assert.throws(
      () =>
        kernel.advanceWorkflow(principal, {
          instanceId: created.instanceId,
          expectedRevision: 3,
          expectedState: "resolved",
          transitionName: "reopen",
          toState: "investigating",
          data: {},
        }),
      conflict("is terminal"),
    );
  } finally {
    store.close();
  }
});

test("generic operations cannot bypass retail workflow invariants", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  try {
    assert.throws(
      () =>
        kernel.createWorkflow(principal, {
          instanceId: "order:forged",
          workflowType: "retail_order",
          initialState: "confirmed",
          data: {},
        }),
      /retail_order is reserved/,
    );
    assert.throws(
      () =>
        kernel.createWorkflow(principal, {
          instanceId: "order:blocked",
          workflowType: "incident_response",
          initialState: "open",
          data: {},
        }),
      /order: identifier namespace is reserved/,
    );
    kernel.seedInventory(principal, "camera", "store", 2);
    const reservation = kernel.reserveInventory(principal, {
      orderId: "1001",
      sku: "camera",
      location: "store",
      quantity: 1,
      holdSeconds: 600,
      idempotencyKey: "reserve-1001",
    });
    assert.throws(
      () =>
        kernel.advanceWorkflow(principal, {
          instanceId: reservation.machine.instanceId,
          expectedRevision: 1,
          expectedState: "reserved",
          transitionName: "forge_confirmation",
          toState: "confirmed",
          data: {},
          terminal: true,
        }),
      conflict("cannot modify retail orders"),
    );
    const payment = kernel.requestPayment(principal, {
      instanceId: reservation.machine.instanceId,
      amount: "10",
      currency: "USD",
      paymentTarget: "https://payments.example.com/capture",
      paymentStatusUrl: "https://payments.example.com/status/1001",
      idempotencyKey: "payment-1001",
    });
    assert.throws(
      () =>
        kernel.recordEffectOutcome(principal, {
          effectId: payment.effectId,
          idempotencyKey: "forged-outcome",
          status: "succeeded",
        }),
      conflict("cannot finalize retail payment effects"),
    );
  } finally {
    store.close();
  }
});

test("Agent Intent replays generic workflow creation idempotently", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  try {
    const input = {
      protocolVersion: "0.1",
      requestId: "create-incident",
      idempotencyKey: "create-incident",
      principal,
      operation: {
        op: "create_workflow",
        instanceId: "incident:replay",
        workflowType: "incident_response",
        initialState: "open",
        data: { severity: 3 },
      },
    };
    const first = executeIntent(kernel, input);
    const replay = executeIntent(kernel, input);
    assert.equal(first.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.deepEqual(
      replay.result,
      first.result,
    );
  } finally {
    store.close();
  }
});

test("SQLite upgrades rebuild effect foreign keys without losing data", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-agency-upgrade-"));
  const databasePath = join(directory, "agency.db");
  let effectId = "";
  try {
    const initialStore = new SqliteStore(databasePath);
    const initialKernel = new AgenticKernel(initialStore);
    try {
      initialKernel.seedInventory(principal, "camera", "store", 1);
      const reservation = initialKernel.reserveInventory(principal, {
        orderId: "upgrade",
        sku: "camera",
        location: "store",
        quantity: 1,
        holdSeconds: 600,
        idempotencyKey: "upgrade-reservation",
      });
      effectId = initialKernel.requestPayment(principal, {
        instanceId: reservation.machine.instanceId,
        amount: "10",
        currency: "USD",
        paymentTarget: "https://payments.example.com/capture",
        paymentStatusUrl: "https://payments.example.com/status/upgrade",
        idempotencyKey: "upgrade-payment",
      }).effectId;
    } finally {
      initialStore.close();
    }

    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        CREATE TABLE effect_intents_legacy (
          tenant_id TEXT NOT NULL,
          effect_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          originating_revision INTEGER NOT NULL,
          effect_name TEXT NOT NULL,
          effect_type TEXT NOT NULL,
          target TEXT NOT NULL,
          request_json TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL,
          outcome_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, effect_id),
          UNIQUE (
            tenant_id,
            instance_id,
            originating_revision,
            effect_name
          ),
          FOREIGN KEY (tenant_id, instance_id)
            REFERENCES machine_instances (tenant_id, instance_id)
        ) STRICT;
        INSERT INTO effect_intents_legacy (
          tenant_id, effect_id, instance_id, originating_revision,
          effect_name, effect_type, target, request_json, idempotency_key,
          status, attempt_count, outcome_json, created_at, updated_at
        )
        SELECT
          tenant_id, effect_id, instance_id, originating_revision,
          effect_name, effect_type, target, request_json, idempotency_key,
          status, attempt_count, outcome_json, created_at, updated_at
        FROM effect_intents;
        DROP TABLE effect_intents;
        ALTER TABLE effect_intents_legacy RENAME TO effect_intents;
        COMMIT;
      `);
    } finally {
      legacy.close();
    }

    const upgradedStore = new SqliteStore(databasePath);
    const upgradedKernel = new AgenticKernel(upgradedStore);
    try {
      const foreignKeys = upgradedStore.all<{ table: string }>(
        "PRAGMA foreign_key_list(effect_intents)",
      );
      assert.ok(
        foreignKeys.some(
          (foreignKey) => foreignKey.table === "machine_history",
        ),
      );
      assert.equal(
        foreignKeys.filter(
          (foreignKey) => foreignKey.table === "assertions",
        ).length,
        4,
      );
      const effect = upgradedKernel.listEffects(
        principal.tenantId,
        "order:upgrade",
      )[0];
      assert.equal(effect?.effectId, effectId);
      assert.equal(effect?.outcomeHandler, "retail_order_payment");
    } finally {
      upgradedStore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("trace formatting escapes terminal control characters", () => {
  const formatted = formatTraceExplanation({
    root: { type: "assertion", assertionId: "root\nid" },
    maxDepth: 0,
    truncated: false,
    nodes: [
      {
        ref: { type: "assertion", assertionId: "root\nid" },
        depth: 0,
        label: "forged\n[0] node\u001b[2J",
        record: {},
      },
    ],
    edges: [],
  });
  assert.doesNotMatch(formatted, /\u001b/);
  assert.match(formatted, /root\\nid/);
  assert.match(formatted, /forged\\n\[0\] node\\u001b\[2J/);
});

test("trace bounds do not return dangling lineage edges", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  try {
    kernel.putEntity(principal, {
      entityId: "trace:entity",
      entityType: "trace",
      canonicalName: "Trace Entity",
    });
    kernel.assert(principal, {
      assertionId: "trace:root",
      subjectEntityId: "trace:entity",
      predicate: "root",
      object: { type: "boolean", value: true },
      kind: "hypothesis",
    });
    for (let index = 0; index < 510; index += 1) {
      const assertionId = `trace:node:${index}`;
      kernel.assert(principal, {
        assertionId,
        subjectEntityId: "trace:entity",
        predicate: `node_${index}`,
        object: { type: "number", value: index },
        kind: "observation",
      });
      kernel.addLineage(principal, {
        relation: "supports",
        from: { type: "assertion", assertionId },
        to: { type: "assertion", assertionId: "trace:root" },
      });
    }
    const explanation = kernel.explain(
      principal.tenantId,
      { type: "assertion", assertionId: "trace:root" },
      1,
    );
    assert.equal(explanation.nodes.length, 500);
    assert.equal(explanation.edges.length, 499);
    assert.equal(explanation.truncated, true);
    const nodeKeys = new Set(
      explanation.nodes.map((node) => traceEndpointKey(node.ref)),
    );
    for (const edge of explanation.edges) {
      assert.ok(nodeKeys.has(traceEndpointKey(edge.from)));
      assert.ok(nodeKeys.has(traceEndpointKey(edge.to)));
    }
  } finally {
    store.close();
  }
});

function conflict(message: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof KernelError &&
    error.code === "conflict" &&
    error.message.includes(message);
}
