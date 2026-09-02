import { randomUUID } from "node:crypto";

const config = {
  baseUrl: required("AGENTIC_DATA_BASE_URL").replace(/\/+$/, ""),
  token: required("AGENTIC_DATA_API_KEY"),
  tenantId: required("AGENTIC_DATA_TENANT_ID"),
  principalId: required("AGENTIC_DATA_PRINCIPAL_ID"),
  purpose: required("AGENTIC_DATA_PURPOSE"),
  paymentTarget: required("PAYMENT_TARGET_URL"),
  paymentStatusBaseUrl: required("PAYMENT_STATUS_BASE_URL").replace(/\/+$/, ""),
};
const orderId = process.env.ORDER_ID ?? `sample-${Date.now()}`;

await execute(`product-${orderId}`, {
  op: "put_entity",
  entity: {
    entityId: "product:camera-1",
    entityType: "product",
    canonicalName: "Trail Camera",
  },
});
await execute(`inventory-${orderId}`, {
  op: "seed_inventory",
  sku: `camera-${orderId}`,
  location: "store-1",
  quantityOnHand: 10,
});
await execute(`reserve-${orderId}`, {
  op: "reserve_inventory",
  orderId,
  sku: `camera-${orderId}`,
  location: "store-1",
  quantity: 1,
  holdSeconds: 600,
  idempotencyKey: `reserve-${orderId}`,
});
const payment = await execute(`payment-${orderId}`, {
  op: "request_payment",
  instanceId: `order:${orderId}`,
  amount: "149.98",
  currency: "USD",
  paymentTarget: config.paymentTarget,
  paymentStatusUrl: `${config.paymentStatusBaseUrl}/status/${encodeURIComponent(
    `payment-${orderId}`,
  )}`,
  idempotencyKey: `payment-${orderId}`,
});

let state = "payment_pending";
for (let attempt = 0; attempt < 30; attempt += 1) {
  const machine = await execute(undefined, {
    op: "get_machine",
    instanceId: `order:${orderId}`,
  });
  state = String(objectField(machine.result, "state"));
  if (state === "confirmed" || state === "failed") {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

console.log(
  JSON.stringify(
    {
      orderId,
      effectId: objectField(payment.result, "effectId"),
      finalState: state,
    },
    null,
    2,
  ),
);

async function execute(
  idempotencyKey: string | undefined,
  operation: object,
): Promise<{ result: unknown }> {
  const response = await fetch(`${config.baseUrl}/v1/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      "x-agent-purpose": config.purpose,
    },
    body: JSON.stringify({
      protocolVersion: "0.1",
      requestId: randomUUID(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      principal: {
        tenantId: config.tenantId,
        principalId: config.principalId,
        purpose: config.purpose,
      },
      operation,
    }),
  });
  const value = (await response.json()) as { result?: unknown };
  if (!response.ok || value.result === undefined) {
    throw new Error(
      `Operation failed with ${response.status}: ${JSON.stringify(value)}`,
    );
  }
  return { result: value.result };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function objectField(value: unknown, field: string): unknown {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? (value as Record<string, unknown>)[field]
    : undefined;
}
