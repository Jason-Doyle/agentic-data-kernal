import { randomUUID } from "node:crypto";

const config = {
  baseUrl: required("AGENTIC_DATA_BASE_URL").replace(/\/+$/, ""),
  token: required("AGENTIC_DATA_API_KEY"),
  tenantId: required("AGENTIC_DATA_TENANT_ID"),
  principalId: required("AGENTIC_DATA_PRINCIPAL_ID"),
  purpose: required("AGENTIC_DATA_PURPOSE"),
};

const catalog = await request("GET", "/v1/catalog");
const execution = await request("POST", "/v1/execute", {
  protocolVersion: "0.1",
  requestId: randomUUID(),
  idempotencyKey: `http-example-${Date.now()}`,
  principal: {
    tenantId: config.tenantId,
    principalId: config.principalId,
    purpose: config.purpose,
  },
  operation: {
    op: "put_entity",
    entity: {
      entityId: `integration:${Date.now()}`,
      entityType: "integration_example",
      canonicalName: "Production HTTP Example",
    },
  },
});

console.log(
  JSON.stringify(
    {
      profile: objectField(catalog, "profile"),
      receiptId: objectField(objectField(execution, "receipt"), "receiptId"),
    },
    null,
    2,
  ),
);

async function request(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      "x-agent-purpose": config.purpose,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}: ${JSON.stringify(value)}`);
  }
  return value;
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
