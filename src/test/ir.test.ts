import assert from "node:assert/strict";
import test from "node:test";
import { AgenticKernel } from "../kernel.js";
import { executeIntent } from "../ir.js";
import { SqliteStore } from "../store.js";

test("intent execution returns a receipt and replays idempotently", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  const envelope = {
    protocolVersion: "0.1",
    requestId: "request-1",
    idempotencyKey: "entity-1",
    principal: {
      tenantId: "tenant-a",
      principalId: "agent-a",
      purpose: "test",
    },
    operation: {
      op: "put_entity",
      entity: {
        entityId: "customer:1",
        entityType: "customer",
        canonicalName: "Customer One",
      },
    },
  };

  const first = executeIntent(kernel, envelope);
  const replay = executeIntent(kernel, {
    ...envelope,
    requestId: "request-2",
  });
  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(first.receipt.receiptId, replay.receipt.receiptId);
  assert.equal(replay.requestId, "request-2");
  assert.equal(replay.receipt.requestId, "request-1");
  assert.deepEqual(first.result, replay.result);
  assert.throws(
    () =>
      executeIntent(kernel, {
        ...envelope,
        operation: {
          op: "put_entity",
          entity: {
            entityId: "customer:2",
            entityType: "customer",
            canonicalName: "Different Customer",
          },
        },
      }),
    /already used for a different request/,
  );
  store.close();
});

test("Agent Intent 1.0 is stable while 0.1 remains compatible", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  try {
    const result = executeIntent(kernel, {
      protocolVersion: "1.0",
      requestId: "stable-request",
      principal: {
        tenantId: "stable-tenant",
        principalId: "stable-agent",
        purpose: "test",
      },
      operation: {
        op: "put_entity",
        entity: {
          entityId: "entity:stable",
          entityType: "test",
          canonicalName: "Stable Entity",
        },
      },
    });
    assert.equal(result.protocolVersion, "1.0");
    assert.equal(kernel.catalog().protocolVersion, "1.0");
    assert.deepEqual(
      kernel.catalog().supportedProtocolVersions,
      ["0.1", "1.0"],
    );
  } finally {
    store.close();
  }
});

test("human SQL surface rejects writes", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  assert.throws(
    () => kernel.readSql("DELETE FROM entities"),
    /Only SELECT, EXPLAIN/,
  );
  assert.throws(
    () =>
      kernel.readSql(
        "WITH selected AS (SELECT entity_id FROM entities) DELETE FROM entities",
      ),
    /Only SELECT, EXPLAIN/,
  );
  const rows = kernel.readSql("SELECT COUNT(*) AS count FROM entities");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.count, 0);
  store.close();
});

test("receipt identity includes the principal", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  const base = {
    protocolVersion: "0.1",
    requestId: "shared-request",
    operation: {
      op: "put_entity",
      entity: {
        entityId: "entity:shared",
        entityType: "test",
        canonicalName: "Shared Entity",
      },
    },
  };
  const first = executeIntent(kernel, {
    ...base,
    principal: {
      tenantId: "tenant-a",
      principalId: "agent-a",
      purpose: "test",
    },
  });
  const second = executeIntent(kernel, {
    ...base,
    principal: {
      tenantId: "tenant-a",
      principalId: "agent-b",
      purpose: "test",
    },
  });
  assert.notEqual(first.receipt.receiptId, second.receipt.receiptId);
  const receipts = kernel.readSql(
    "SELECT principal_id FROM execution_receipts ORDER BY principal_id",
  );
  assert.deepEqual(
    receipts.map((row) => row.principal_id),
    ["agent-a", "agent-b"],
  );
  store.close();
});
