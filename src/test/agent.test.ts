import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  DEFAULT_MODEL_OPERATION_NAMES,
  createEmbeddedAgentMiddleware,
  type AgentToolDefinition,
} from "../agent.js";
import { AgenticKernel, KernelError } from "../kernel.js";
import {
  AgentDataHttpError,
  createProductionHttpAgentMiddleware,
} from "../production/agent.js";
import { SqliteStore } from "../store.js";
import type { JsonValue, PrincipalContext } from "../types.js";
import { sha256, stableStringify } from "../util.js";

const principal: PrincipalContext = {
  tenantId: "agent-middleware-tenant",
  principalId: "middleware-agent",
  purpose: "incident-response",
};

test("agent middleware prepares model context and executes bound tools", async () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  try {
    const middleware = createEmbeddedAgentMiddleware(kernel, principal, {
      maxContextCharacters: 4_000,
    });
    const session = middleware.beginRun({
      runId: "run:incident-1001",
      taskId: "incident:1001",
      conversationId: "conversation:1001",
      durableMetadata: { source: "alert-manager" },
    });

    assert.deepEqual(session.identity(), principal);
    assert.equal(Object.isFrozen(DEFAULT_MODEL_OPERATION_NAMES), true);
    assert.throws(() =>
      Reflect.apply(
        Array.prototype.push,
        DEFAULT_MODEL_OPERATION_NAMES,
        ["put_artifact"],
      ),
    );
    assert.deepEqual(session.runInfo().durableMetadata, {
      source: "alert-manager",
    });
    assertModelToolContract(session.modelTools());

    const entity = await session.invokeTool({
      callId: "create-service",
      name: "execute_operation",
      arguments: {
        idempotencyKey: "create-service",
        operation: {
          op: "put_entity",
          entity: {
            entityId: "service:checkout",
            entityType: "service",
            canonicalName: "Checkout",
          },
        },
      },
    });
    assert.equal(field(entity.result, "entityId"), "service:checkout");
    const replay = await session.invokeTool({
      callId: "create-service-retry",
      name: "execute_operation",
      arguments: {
        idempotencyKey: "create-service",
        operation: {
          op: "put_entity",
          entity: {
            entityId: "service:checkout",
            entityType: "service",
            canonicalName: "Checkout",
          },
        },
      },
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.receipt.receiptId, entity.receipt.receiptId);

    await session.execute({
      op: "assert",
      assertion: {
        assertionId: "assertion:error-rate",
        subjectEntityId: "service:checkout",
        predicate: "error_rate",
        object: { type: "number", value: 0.42 },
        kind: "observation",
      },
    });
    await session.execute({
      op: "create_workflow",
      instanceId: "incident:1001",
      workflowType: "incident_response",
      initialState: "investigating",
      data: {
        summary: "x".repeat(5_000),
      },
    });

    const prepared = await session.prepareModelInput({
      query: "checkout error rate",
      resolutions: [
        {
          subjectEntityId: "service:checkout",
          predicate: "error_rate",
          policy: "latest",
        },
      ],
      workflow: { instanceId: "incident:1001" },
      maxCharacters: 1_000,
    });
    assert.deepEqual(
      prepared.context.sections.map((section) => section.type),
      ["search", "resolution", "workflow"],
    );
    assert.equal(
      prepared.context.includedReceiptIds.length +
        prepared.context.partialReceiptIds.length +
        prepared.context.omittedReceiptIds.length,
      3,
    );
    assert.equal(prepared.context.truncated, true);
    assert.ok(prepared.context.modelContext.length <= 1_000);
    const visibleContext = JSON.parse(
      prepared.context.modelContext,
    ) as {
      sections: Array<{ status: string; receiptId: string }>;
    };
    assert.equal(visibleContext.sections.length, 3);
    assert.ok(
      visibleContext.sections.every(
        (section) =>
          section.status === "complete" ||
          section.status === "truncated" ||
          section.status === "omitted",
      ),
    );

    const recorded = await session.recordTurn({
      turnId: "turn-1",
      input: { role: "user", content: "Investigate checkout" },
      output: { role: "assistant", content: "Error rate is elevated" },
      contextReceiptIds: prepared.context.includedReceiptIds,
      toolCalls: [
        {
          name: entity.name,
          arguments: { operation: "put_entity" },
          result: entity.result,
          receiptId: entity.receipt.receiptId,
        },
      ],
    });
    const recordedReplay = await session.recordTurn({
      turnId: "turn-1",
      input: { role: "user", content: "Investigate checkout" },
      output: { role: "assistant", content: "Error rate is elevated" },
      contextReceiptIds: prepared.context.includedReceiptIds,
      toolCalls: [
        {
          name: entity.name,
          arguments: { operation: "put_entity" },
          result: entity.result,
          receiptId: entity.receipt.receiptId,
        },
      ],
    });
    assert.equal(recordedReplay.idempotentReplay, true);
    assert.equal(recordedReplay.artifactId, recorded.artifactId);
    const turnArtifact = kernel.getArtifact(
      principal.tenantId,
      recorded.artifactId,
    );
    const turn = JSON.parse(turnArtifact.content) as {
      run: {
        taskId: string;
        conversationId: string;
        metadata: { source: string };
      };
      principal: PrincipalContext;
      turn: { turnId: string; contextReceiptIds: string[] };
    };
    assert.equal(turn.run.taskId, "incident:1001");
    assert.equal(turn.run.conversationId, "conversation:1001");
    assert.equal(turn.run.metadata.source, "alert-manager");
    assert.deepEqual(turn.principal, principal);
    assert.equal(turn.turn.turnId, "turn-1");
    assert.deepEqual(
      turn.turn.contextReceiptIds,
      prepared.context.includedReceiptIds,
    );

    await assert.rejects(
      () =>
        session.invokeTool({
          name: "execute_operation",
          arguments: {
            operation: {
              op: "record_effect_outcome",
              effectId: "effect:blocked",
              idempotencyKey: "blocked",
              status: "succeeded",
            },
          },
        }),
      (error: unknown) =>
        error instanceof KernelError &&
        error.code === "unauthorized" &&
        /does not expose record_effect_outcome/.test(error.message),
    );

    const restrictedSession = createEmbeddedAgentMiddleware(
      kernel,
      principal,
      {
        allowedOperations: ["search"],
        maxTurnCharacters: 1_000,
      },
    ).beginRun({ runId: "run:restricted" });
    assert.deepEqual(
      restrictedSession.modelTools().map((tool) => tool.name),
      ["search_knowledge", "execute_operation"],
    );
    const executeSchema = JSON.stringify(
      restrictedSession.modelTools().find(
        (tool) => tool.name === "execute_operation",
      )?.inputSchema,
    );
    assert.match(executeSchema, /"const":"search"/);
    assert.doesNotMatch(executeSchema, /"const":"put_entity"/);
    await assert.rejects(
      () =>
        restrictedSession.invokeTool({
          name: "execute_operation",
          arguments: {
            operation: {
              op: "put_entity",
              entity: {
                entityId: "blocked",
                entityType: "test",
                canonicalName: "Blocked",
              },
            },
          },
        }),
      /does not expose put_entity/,
    );
    await assert.rejects(
      () =>
        restrictedSession.recordTurn({
          turnId: "oversized",
          output: { text: "x".repeat(2_000) },
        }),
      /Agent turn exceeds 1000/,
    );
    const restrictedTurn = await restrictedSession.recordTurn({
      turnId: "host-owned",
      output: { text: "Stored by the host, not exposed as a model tool." },
    });
    assert.ok(restrictedTurn.artifactId.startsWith("agent-turn:"));
    assert.throws(
      () =>
        createEmbeddedAgentMiddleware(kernel, principal, {
          allowedOperations: ["seed_inventory"],
        }),
      /cannot expose privileged operation seed_inventory/,
    );

    await session.invokeTool({
      callId: "namespace-tool",
      name: "execute_operation",
      arguments: {
        idempotencyKey: "turn:turn-2",
        operation: {
          op: "put_entity",
          entity: {
            entityId: "service:namespace",
            entityType: "service",
            canonicalName: "Namespace Test",
          },
        },
      },
    });
    const namespaceTurn = await session.recordTurn({
      turnId: "turn-2",
      output: { content: "Idempotency namespaces do not collide." },
    });
    assert.equal(namespaceTurn.idempotentReplay, false);

    const secondPrincipalSession = createEmbeddedAgentMiddleware(
      kernel,
      {
        ...principal,
        principalId: "second-middleware-agent",
      },
    ).beginRun({
      runId: "run:incident-1001",
    });
    const secondPrincipalTurn = await secondPrincipalSession.recordTurn({
      turnId: "turn-1",
      output: { content: "Independent principal record." },
    });
    assert.notEqual(
      secondPrincipalTurn.artifactId,
      recorded.artifactId,
    );

    assert.throws(
      () =>
        createEmbeddedAgentMiddleware(
          kernel,
          principal,
        ).beginRun({ runId: "run\u0000segment" }),
      /must not contain control characters/,
    );
    await assert.rejects(
      () =>
        session.execute(
          {
            op: "put_entity",
            entity: {
              entityId: "entity:null-boundary",
              entityType: "test",
              canonicalName: "Null Boundary",
            },
          },
          { idempotencyKey: "key\u0000segment" },
        ),
      /must not contain control characters/,
    );
  } finally {
    store.close();
  }
});

test("production HTTP middleware binds identity and maps API errors", async () => {
  let rejectRequest = false;
  let mismatchResponse = false;
  let oversizedResponse = false;
  let delayBodyResponse = false;
  let capturedAuthorization = "";
  let capturedPurpose = "";
  let capturedBody: unknown;
  const server = createServer(async (request, response) => {
    capturedAuthorization = request.headers.authorization ?? "";
    capturedPurpose = request.headers["x-agent-purpose"]?.toString() ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    if (oversizedResponse) {
      response.writeHead(200);
      response.end("x".repeat(2_000));
      return;
    }
    if (delayBodyResponse) {
      response.writeHead(200);
      response.write('{"protocolVersion":"1.0",');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      response.end('"status":"ok"}');
      return;
    }
    if (rejectRequest) {
      response.writeHead(403);
      response.end(
        JSON.stringify({
          error: {
            code: "authorization_failed",
            message: "Scope data:read is required",
          },
          requestId: "server-request",
        }),
      );
      return;
    }
    const envelope = capturedBody as {
      requestId: string;
      operation: { op: string };
      principal: PrincipalContext;
    };
    const result = {
      instanceId: "incident:http",
      state: "investigating",
    };
    response.writeHead(200);
    response.end(
      JSON.stringify({
        protocolVersion: "1.0",
        requestId: envelope.requestId,
        status: "ok",
        operation: envelope.operation.op,
        result,
        receipt: {
          tenantId: mismatchResponse
            ? "different-tenant"
            : envelope.principal.tenantId,
          receiptId: "receipt:http",
          requestId: envelope.requestId,
          principalId: envelope.principal.principalId,
          purpose: envelope.principal.purpose,
          operation: envelope.operation.op,
          snapshotTime: "2026-09-04T00:00:00.000Z",
          evidenceManifest: [],
          resultHash: sha256(stableStringify(result)),
          result,
          createdAt: "2026-09-04T00:00:00.000Z",
        },
        idempotentReplay: false,
      }),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const port = (server.address() as AddressInfo).port;
  try {
    const session = createProductionHttpAgentMiddleware({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "test-api-key",
      principal,
    }).beginRun({ runId: "run:http" });
    const result = await session.invokeTool({
      callId: "machine",
      name: "get_machine",
      arguments: { instanceId: "incident:http" },
    });
    assert.equal(capturedAuthorization, "Bearer test-api-key");
    assert.equal(capturedPurpose, principal.purpose);
    assert.deepEqual(
      (capturedBody as { principal: PrincipalContext }).principal,
      principal,
    );
    assert.equal(field(result.result, "state"), "investigating");

    rejectRequest = true;
    await assert.rejects(
      () =>
        session.invokeTool({
          callId: "machine-forbidden",
          name: "get_machine",
          arguments: { instanceId: "incident:http" },
        }),
      (error: unknown) =>
        error instanceof AgentDataHttpError &&
        error.status === 403 &&
        error.code === "authorization_failed" &&
        error.requestId === "server-request",
    );
    rejectRequest = false;
    mismatchResponse = true;
    await assert.rejects(
      () =>
        session.invokeTool({
          callId: "machine-mismatch",
          name: "get_machine",
          arguments: { instanceId: "incident:http" },
        }),
      (error: unknown) =>
        error instanceof AgentDataHttpError &&
        error.status === 502 &&
        error.code === "response_mismatch",
    );
    mismatchResponse = false;

    oversizedResponse = true;
    const sizeLimitedSession = createProductionHttpAgentMiddleware({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "test-api-key",
      principal,
      maxResponseBytes: 1_024,
    }).beginRun({ runId: "run:http-size" });
    await assert.rejects(
      () =>
        sizeLimitedSession.invokeTool({
          callId: "machine-large",
          name: "get_machine",
          arguments: { instanceId: "incident:http" },
        }),
      (error: unknown) =>
        error instanceof AgentDataHttpError &&
        error.code === "response_too_large",
    );
    oversizedResponse = false;

    delayBodyResponse = true;
    const timeoutSession = createProductionHttpAgentMiddleware({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "test-api-key",
      principal,
      requestTimeoutMs: 1_000,
    }).beginRun({ runId: "run:http-timeout" });
    await assert.rejects(
      () =>
        timeoutSession.invokeTool({
          callId: "machine-timeout",
          name: "get_machine",
          arguments: { instanceId: "incident:http" },
        }),
      (error: unknown) =>
        error instanceof AgentDataHttpError &&
        error.status === 504 &&
        error.code === "timeout",
    );
    delayBodyResponse = false;

    assert.throws(
      () =>
        createProductionHttpAgentMiddleware({
          baseUrl: "http://database.example.com",
          apiKey: "test-api-key",
          principal,
        }),
      /requires HTTPS/,
    );
    assert.throws(
        () =>
          createProductionHttpAgentMiddleware({
            baseUrl: "http://127.example.com",
            apiKey: "test-api-key",
            principal,
          }),
        /requires HTTPS/,
    );
    assert.throws(
        () =>
          createProductionHttpAgentMiddleware({
            baseUrl: "http://127.0.0.1.example.com",
            apiKey: "test-api-key",
            principal,
          }),
        /requires HTTPS/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function assertModelToolContract(tools: AgentToolDefinition[]): void {
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "search_knowledge",
      "resolve_claims",
      "get_machine",
      "list_effects",
      "explain_trace",
      "execute_operation",
    ],
  );
  const serialized = JSON.stringify(tools);
  assert.doesNotMatch(serialized, /tenantId|principalId|purpose/);
  assert.equal(
    tools.find((tool) => tool.name === "search_knowledge")?.readOnly,
    true,
  );
  assert.equal(
    tools.find((tool) => tool.name === "execute_operation")?.readOnly,
    false,
  );
  const resolveSchema = requiredTool(
    tools,
    "resolve_claims",
  ).inputSchema;
  assert.ok(
    !arrayField(resolveSchema, "required").includes("policy"),
  );
  const ajv = new Ajv2020({
    strict: false,
    formats: {
      "date-time": {
        type: "string",
        validate: (value: string) => !Number.isNaN(Date.parse(value)),
      },
    },
  });
  const validateResolve = ajv.compile(resolveSchema);
  assert.equal(
    validateResolve({
      subjectEntityId: "service:checkout",
      predicate: "owner",
    }),
    true,
  );
  const validateSearch = ajv.compile(
    requiredTool(tools, "search_knowledge").inputSchema,
  );
  assert.equal(validateSearch({ text: " " }), false);

  const executeSchema = requiredTool(
    tools,
    "execute_operation",
  ).inputSchema;
  const operationSchema = objectField(
    objectField(executeSchema, "properties"),
    "operation",
  );
  const payment = operationVariant(
    operationSchema,
    "request_payment",
  );
  assert.deepEqual(
    objectField(
      objectField(
        objectField(payment, "properties"),
        "amount",
      ),
      "not",
    ).enum,
    ["0", "0.0", "0.00", "0.000", "0.0000"],
  );
  const effect = operationVariant(
    operationSchema,
    "request_effect",
  );
  assert.ok(Array.isArray(effect.allOf));
  const validateExecute = ajv.compile(executeSchema);
  assert.equal(
    validateExecute({
      operation: {
        op: "request_payment",
        instanceId: "order:1",
        amount: "0",
        currency: "USD",
        paymentTarget: "https://payments.example.com/capture",
        idempotencyKey: "payment-1",
      },
    }),
    false,
  );
  assert.equal(
    validateExecute({
      operation: {
        op: "request_payment",
        instanceId: "order:1",
        amount: "0.01",
        currency: "USD",
        paymentTarget: "https://payments.example.com/capture",
        idempotencyKey: "payment-1",
      },
    }),
    true,
  );
  assert.equal(
    validateExecute({
      operation: {
        op: "put_entity",
        entity: {
          entityId: " ",
          entityType: "service",
          canonicalName: "Checkout",
        },
      },
    }),
    false,
  );
  assert.equal(
    validateExecute({
      operation: {
        op: "request_effect",
        instanceId: "incident:1",
        expectedRevision: 1,
        effectName: "rollback",
        effectType: "deployment.rollback",
        target: "https://deployments.example.com/rollback",
        request: {},
        idempotencyKey: "rollback-1",
        decisionAssertionId: "assertion:decision",
        policyAssertionId: "assertion:policy",
        budgetAmount: "1",
      },
    }),
    false,
  );
  assert.equal(
    validateExecute({
      operation: {
        op: "request_effect",
        instanceId: "incident:1",
        expectedRevision: 1,
        effectName: "rollback",
        effectType: "deployment.rollback",
        target: "https://deployments.example.com/rollback",
        request: {},
        idempotencyKey: "rollback-1",
        decisionAssertionId: "assertion:decision",
        policyAssertionId: "assertion:policy",
        budgetAmount: "1",
        currency: "USD",
      },
    }),
    true,
  );
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

function requiredTool(
  tools: AgentToolDefinition[],
  name: AgentToolDefinition["name"],
): AgentToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected tool ${name}`);
  }
  return tool;
}

function operationVariant(
  operationSchema: Record<string, unknown>,
  operationName: string,
): Record<string, unknown> {
  const variants = arrayField(operationSchema, "oneOf");
  const variant = variants.find((candidate) => {
    if (!isObject(candidate)) {
      return false;
    }
    return (
      objectField(
        objectField(candidate, "properties"),
        "op",
      ).const === operationName
    );
  });
  if (!isObject(variant)) {
    throw new Error(`Expected operation schema ${operationName}`);
  }
  return variant;
}

function objectField(
  value: Record<string, unknown>,
  fieldName: string,
): Record<string, unknown> {
  const fieldValue = value[fieldName];
  if (!isObject(fieldValue)) {
    throw new Error(`Expected object field ${fieldName}`);
  }
  return fieldValue;
}

function arrayField(
  value: Record<string, unknown>,
  fieldName: string,
): unknown[] {
  const fieldValue = value[fieldName];
  if (!Array.isArray(fieldValue)) {
    return [];
  }
  return fieldValue;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
