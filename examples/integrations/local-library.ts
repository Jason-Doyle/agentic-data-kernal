import { rmSync } from "node:fs";
import {
  AgenticKernel,
  SqliteStore,
  executeIntent,
  type AgentOperation,
  type IntentExecutionResult,
} from "agentic-data-kernel";

const databasePath = ".data/integration-library.db";
for (const path of [
  databasePath,
  `${databasePath}-shm`,
  `${databasePath}-wal`,
]) {
  rmSync(path, { force: true });
}

const store = new SqliteStore(databasePath);
const kernel = new AgenticKernel(store);
const principal = {
  tenantId: "integration-example",
  principalId: "catalog-service",
  purpose: "catalog-import",
};

function execute(
  idempotencyKey: string,
  operation: AgentOperation,
): IntentExecutionResult {
  return executeIntent(kernel, {
    protocolVersion: "1.0",
    requestId: `library-${idempotencyKey}`,
    idempotencyKey,
    principal,
    operation,
  });
}

try {
  execute("product", {
    op: "put_entity",
    entity: {
      entityId: "product:camera-1",
      entityType: "product",
      canonicalName: "Trail Camera",
    },
  });
  execute("weight-a", {
    op: "assert",
    assertion: {
      subjectEntityId: "product:camera-1",
      predicate: "packaged_weight",
      object: { type: "number", value: 4.8, unit: "kg" },
      kind: "reported_fact",
      authority: 70,
    },
  });
  execute("weight-b", {
    op: "assert",
    assertion: {
      subjectEntityId: "product:camera-1",
      predicate: "packaged_weight",
      object: { type: "number", value: 5.1, unit: "kg" },
      kind: "reported_fact",
      authority: 60,
    },
  });
  const resolution = execute("resolve-weight", {
    op: "resolve",
    subjectEntityId: "product:camera-1",
    predicate: "packaged_weight",
    policy: "none",
  });
  console.log(
    JSON.stringify(
      {
        status: objectField(resolution.result, "status"),
        receiptId: resolution.receipt.receiptId,
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

function objectField(
  value: IntentExecutionResult["result"],
  field: string,
): unknown {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? value[field]
    : undefined;
}
