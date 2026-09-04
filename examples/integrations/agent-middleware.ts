import { rmSync } from "node:fs";
import {
  AgenticKernel,
  SqliteStore,
  createEmbeddedAgentMiddleware,
} from "agentic-data-kernel";

const databasePath = ".data/integration-agent-middleware.db";
for (const path of [
  databasePath,
  `${databasePath}-shm`,
  `${databasePath}-wal`,
]) {
  rmSync(path, { force: true });
}

const store = new SqliteStore(databasePath);
const kernel = new AgenticKernel(store);
const session = createEmbeddedAgentMiddleware(kernel, {
  tenantId: "operations",
  principalId: "incident-agent",
  purpose: "incident-response",
}).beginRun({
  runId: "run:checkout-1001",
  taskId: "incident:checkout-1001",
  conversationId: "conversation:checkout-1001",
});

try {
  await session.invokeTool({
    callId: "create-service",
    name: "execute_operation",
    arguments: {
      idempotencyKey: "create-service",
      operation: {
        op: "put_entity",
        entity: {
          entityId: "service:checkout",
          entityType: "service",
          canonicalName: "Checkout API",
        },
      },
    },
  });
  await session.invokeTool({
    callId: "record-error-rate",
    name: "execute_operation",
    arguments: {
      idempotencyKey: "record-error-rate",
      operation: {
        op: "assert",
        assertion: {
          assertionId: "assertion:checkout-error-rate",
          subjectEntityId: "service:checkout",
          predicate: "error_rate",
          object: { type: "number", value: 0.42 },
          kind: "observation",
        },
      },
    },
  });

  const modelInput = await session.prepareModelInput({
    query: "checkout error rate",
    resolutions: [
      {
        subjectEntityId: "service:checkout",
        predicate: "error_rate",
        policy: "latest",
      },
    ],
  });

  const modelOutput = {
    conclusion: "The checkout error rate is elevated.",
    evidenceReceiptIds: modelInput.context.includedReceiptIds,
  };
  const turn = await session.recordTurn({
    turnId: "turn-1",
    input: { role: "user", content: "Investigate checkout" },
    output: modelOutput,
    contextReceiptIds: modelInput.context.includedReceiptIds,
  });

  console.log(
    JSON.stringify(
      {
        modelTools: modelInput.tools.map((tool) => tool.name),
        modelContext: JSON.parse(modelInput.context.modelContext),
        turnArtifactId: turn.artifactId,
        turnReceiptId: turn.receipt.receiptId,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  for (const path of [
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
  ]) {
    rmSync(path, { force: true });
  }
}
