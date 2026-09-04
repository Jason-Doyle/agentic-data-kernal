import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const databasePath = resolve(".data/integration-mcp.db");
for (const path of [
  databasePath,
  `${databasePath}-shm`,
  `${databasePath}-wal`,
]) {
  rmSync(path, { force: true });
}

const client = new Client({
  name: "agentic-data-integration-example",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--no-warnings",
    resolve("dist/cli.js"),
    "mcp",
    "--db",
    databasePath,
  ],
  stderr: "pipe",
});

try {
  await client.connect(transport);
  await executeIntent("entity", {
    op: "put_entity",
    entity: {
      entityId: "service:checkout",
      entityType: "service",
      canonicalName: "Checkout Service",
    },
  });
  await executeIntent("assertion", {
    op: "assert",
    assertion: {
      subjectEntityId: "service:checkout",
      predicate: "owner",
      object: { type: "string", value: "commerce-platform" },
      kind: "reported_fact",
    },
  });
  const result = await client.callTool({
    name: "resolve_claims",
    arguments: {
      tenantId: "integration-example",
      principalId: "operations-client",
      purpose: "service-discovery",
      subjectEntityId: "service:checkout",
      predicate: "owner",
      policy: "none",
    },
  });
  console.log(firstText(result.content));
} finally {
  await client.close();
  for (const path of [
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
  ]) {
    rmSync(path, { force: true });
  }
}

async function executeIntent(
  idempotencyKey: string,
  operation: object,
): Promise<void> {
  await client.callTool({
    name: "execute_intent",
    arguments: {
      envelope: {
        protocolVersion: "1.0",
        requestId: `mcp-${idempotencyKey}`,
        idempotencyKey,
        principal: {
          tenantId: "integration-example",
          principalId: "operations-client",
          purpose: "service-discovery",
        },
        operation,
      },
    },
  });
}

function firstText(content: unknown): string {
  if (
    !Array.isArray(content) ||
    content[0] === null ||
    typeof content[0] !== "object" ||
    !("type" in content[0]) ||
    content[0].type !== "text" ||
    !("text" in content[0]) ||
    typeof content[0].text !== "string"
  ) {
    throw new Error("MCP tool did not return text content");
  }
  return content[0].text;
}
