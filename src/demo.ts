import type { AgenticKernel } from "./kernel.js";
import {
  executeIntent,
  type AgentOperation,
  type IntentExecutionResult,
} from "./ir.js";
import type { JsonValue, PrincipalContext } from "./types.js";
import { toJsonValue } from "./util.js";

const principal: PrincipalContext = {
  tenantId: "retail-demo",
  principalId: "demo-agent",
  purpose: "local-proof-of-concept",
};

export function runDemo(kernel: AgenticKernel): JsonValue {
  const run = (
    key: string,
    operation: AgentOperation,
  ): IntentExecutionResult =>
    executeIntent(kernel, {
      protocolVersion: "0.1",
      requestId: `demo-${key}`,
      idempotencyKey: key,
      principal,
      operation,
    });

  run("entity-product", {
    op: "put_entity",
    entity: {
      entityId: "product:sku-17",
      entityType: "product",
      canonicalName: "Trail Camera Pro",
    },
  });
  run("entity-customer", {
    op: "put_entity",
    entity: {
      entityId: "customer:412",
      entityType: "customer",
      canonicalName: "Customer 412",
    },
  });
  run("entity-incident", {
    op: "put_entity",
    entity: {
      entityId: "incident:456",
      entityType: "incident",
      canonicalName: "Checkout performance degradation",
    },
  });

  run("artifact-supplier-a", {
    op: "put_artifact",
    artifact: {
      artifactId: "artifact:supplier-a",
      mediaType: "text/plain",
      content: "Supplier A reports packaged product weight as 4.8 kg.",
      sourceIdentity: "supplier-a-feed",
    },
  });
  run("artifact-supplier-b", {
    op: "put_artifact",
    artifact: {
      artifactId: "artifact:supplier-b",
      mediaType: "text/plain",
      content: "Supplier B reports packaged product weight as 5.1 kg.",
      sourceIdentity: "supplier-b-feed",
    },
  });
  run("artifact-support", {
    op: "put_artifact",
    artifact: {
      artifactId: "artifact:support-921",
      mediaType: "text/plain",
      content:
        "Customer 412 says the pricing increase and checkout performance problems may cause cancellation.",
      sourceIdentity: "support-conversation-921",
    },
  });

  run("claim-weight-a", {
    op: "assert",
    assertion: {
      assertionId: "assertion:weight-a",
      subjectEntityId: "product:sku-17",
      predicate: "packaged_weight",
      object: { type: "number", value: 4.8, unit: "kg" },
      kind: "reported_fact",
      sourceArtifactId: "artifact:supplier-a",
      strength: { type: "rank", value: "normal" },
      authority: 70,
    },
  });
  run("claim-weight-b", {
    op: "assert",
    assertion: {
      assertionId: "assertion:weight-b",
      subjectEntityId: "product:sku-17",
      predicate: "packaged_weight",
      object: { type: "number", value: 5.1, unit: "kg" },
      kind: "reported_fact",
      sourceArtifactId: "artifact:supplier-b",
      strength: { type: "rank", value: "normal" },
      authority: 60,
    },
  });
  run("claim-churn", {
    op: "assert",
    assertion: {
      assertionId: "assertion:churn",
      subjectEntityId: "customer:412",
      predicate: "intends_to_cancel",
      object: { type: "boolean", value: true },
      kind: "inference",
      sourceArtifactId: "artifact:support-921",
      strength: {
        type: "probability",
        value: 0.74,
        eventDefinition: "Cancellation within 30 days",
      },
      basis: {
        model: "demo-intent-classifier-v1",
        source: "support-conversation-921",
      },
    },
  });
  run("relation-customer-product", {
    op: "assert",
    assertion: {
      assertionId: "assertion:uses",
      subjectEntityId: "customer:412",
      predicate: "uses_product",
      object: { type: "entity", value: "product:sku-17" },
      kind: "reported_fact",
      authority: 90,
    },
  });
  run("relation-incident-customer", {
    op: "assert",
    assertion: {
      assertionId: "assertion:affected",
      subjectEntityId: "incident:456",
      predicate: "affected_customer",
      object: { type: "entity", value: "customer:412" },
      kind: "observation",
      authority: 90,
    },
  });
  run("claim-incident-description", {
    op: "assert",
    assertion: {
      assertionId: "assertion:incident-description",
      subjectEntityId: "incident:456",
      predicate: "summary",
      object: {
        type: "string",
        value:
          "Performance degradation in checkout after a pricing rules rollout.",
      },
      kind: "observation",
      authority: 80,
    },
  });

  const conflict = run("resolve-weight", {
    op: "resolve",
    subjectEntityId: "product:sku-17",
    predicate: "packaged_weight",
    policy: "none",
  });
  const search = run("search-risk", {
    op: "search",
    text: "pricing performance degradation cancellation",
    relatedToEntityId: "customer:412",
    maxGraphDepth: 2,
    limit: 5,
  });

  run("seed-inventory", {
    op: "seed_inventory",
    sku: "sku-17",
    location: "store-3",
    quantityOnHand: 10,
  });
  const reservation = run("reserve-order-1001", {
    op: "reserve_inventory",
    orderId: "1001",
    sku: "sku-17",
    location: "store-3",
    quantity: 2,
    holdSeconds: 900,
    idempotencyKey: "order-1001-reservation",
  });
  const payment = run("payment-order-1001", {
    op: "request_payment",
    instanceId: "order:1001",
    amount: 149.98,
    currency: "USD",
    paymentTarget: "simulated-payments",
    idempotencyKey: "order-1001-payment",
  });
  const effectId = requireStringField(payment.result, "effectId");
  const completed = run("payment-outcome-order-1001", {
    op: "record_payment_outcome",
    effectId,
    idempotencyKey: "payment-outcome-order-1001",
    status: "succeeded",
    outcome: { providerReference: "demo-payment-1001" },
  });

  return toJsonValue({
    conflict: conflict.result,
    search: search.result,
    reservation: reservation.result,
    paymentEffect: payment.result,
    completedOrder: completed.result,
    inventory: kernel.getInventory("retail-demo", "sku-17", "store-3"),
    replaySafe: run("reserve-order-1001", {
      op: "reserve_inventory",
      orderId: "1001",
      sku: "sku-17",
      location: "store-3",
      quantity: 2,
      holdSeconds: 900,
      idempotencyKey: "order-1001-reservation",
    }).idempotentReplay,
  });
}

function requireStringField(value: JsonValue, field: string): string {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    typeof value[field] !== "string"
  ) {
    throw new Error(`Expected ${field} in demo result`);
  }
  return value[field];
}
