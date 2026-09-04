import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { startHttpServer } from "../http.js";
import { AgenticKernel } from "../kernel.js";
import { SqliteStore } from "../store.js";

test("HTTP endpoint executes typed intents", async () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  const server = await startHttpServer(kernel, { port: 0 });
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const catalogResponse = await fetch(`${base}/v1/catalog`);
  assert.equal(catalogResponse.status, 200);
  const catalog = (await catalogResponse.json()) as { protocolVersion: string };
  assert.equal(catalog.protocolVersion, "1.0");

  const executeResponse = await fetch(`${base}/v1/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0.1",
      requestId: "http-request-1",
      principal: {
        tenantId: "tenant-http",
        principalId: "http-agent",
        purpose: "test",
      },
      operation: {
        op: "put_entity",
        entity: {
          entityId: "entity:1",
          entityType: "test",
          canonicalName: "HTTP Entity",
        },
      },
    }),
  });
  assert.equal(executeResponse.status, 200);
  const execution = (await executeResponse.json()) as {
    status: string;
    receipt: { receiptId: string };
  };
  assert.equal(execution.status, "ok");
  assert.match(execution.receipt.receiptId, /^receipt_/);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});
