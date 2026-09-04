import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import {
  agentOperationSchema,
  executeIntent,
  lineageEndpointSchema,
  type AgentOperation,
  type IntentEnvelope,
  type IntentExecutionResult,
} from "./ir.js";
import { AgenticKernel, KernelError } from "./kernel.js";
import type {
  ExecutionReceipt,
  JsonValue,
  LineageEndpoint,
  PrincipalContext,
} from "./types.js";
import { sha256, stableStringify } from "./util.js";
import { AGENT_INTENT_VERSION } from "./version.js";

const nonEmptyString = z.string().trim().min(1);
const middlewareIdentifier = nonEmptyString
  .max(512)
  .regex(
    /^[^\u0000-\u001f\u007f]+$/,
    "Identifiers must not contain control characters",
  );
const safeModelOperationNames = [
  "put_entity",
  "assert",
  "resolve",
  "search",
  "create_workflow",
  "advance_workflow",
  "request_effect",
  "add_lineage",
  "explain",
  "reserve_inventory",
  "request_payment",
  "get_machine",
  "list_effects",
] as const satisfies readonly AgentOperation["op"][];

export const DEFAULT_MODEL_OPERATION_NAMES:
  readonly AgentOperation["op"][] = Object.freeze([
    ...safeModelOperationNames,
  ]);

const agentToolNames = [
  "search_knowledge",
  "resolve_claims",
  "get_machine",
  "list_effects",
  "explain_trace",
  "execute_operation",
] as const;
const agentToolNameSchema = z.enum(agentToolNames);

const searchArgumentsSchema = z
  .object({
    text: nonEmptyString,
    predicate: nonEmptyString.optional(),
    kind: z
      .enum([
        "observation",
        "reported_fact",
        "inference",
        "prediction",
        "hypothesis",
        "decision",
        "directive",
        "experience",
      ])
      .optional(),
    perspective: nonEmptyString.optional(),
    relatedToEntityId: nonEmptyString.optional(),
    maxGraphDepth: z.number().int().min(0).max(8).optional(),
    validAt: z.iso.datetime({ offset: true }).optional(),
    systemAt: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const resolveArgumentsSchema = z
  .object({
    subjectEntityId: nonEmptyString,
    predicate: nonEmptyString,
    policy: z
      .enum(["none", "latest", "highest_authority"])
      .default("none"),
    perspective: nonEmptyString.optional(),
    validAt: z.iso.datetime({ offset: true }).optional(),
    systemAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const machineArgumentsSchema = z
  .object({
    instanceId: nonEmptyString,
  })
  .strict();

const effectsArgumentsSchema = z
  .object({
    instanceId: nonEmptyString.optional(),
    afterEffectId: nonEmptyString.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const explainArgumentsSchema = z
  .object({
    target: lineageEndpointSchema,
    maxDepth: z.number().int().min(0).max(8).optional(),
  })
  .strict();

const executeArgumentsSchema = z
  .object({
    operation: agentOperationSchema,
    idempotencyKey: middlewareIdentifier.optional(),
  })
  .strict();

const contextRequestSchema = z
  .object({
    query: nonEmptyString.optional(),
    search: z
      .union([
        z.literal(false),
        searchArgumentsSchema.partial({ text: true }),
      ])
      .optional(),
    resolutions: z.array(resolveArgumentsSchema).max(20).optional(),
    workflow: machineArgumentsSchema.optional(),
    effects: effectsArgumentsSchema.optional(),
    traces: z.array(explainArgumentsSchema).max(8).optional(),
    maxCharacters: z.number().int().min(1_000).max(100_000).optional(),
  })
  .strict();

const recordedToolCallSchema = z
  .object({
    name: nonEmptyString,
    arguments: z.json(),
    result: z.json().optional(),
    receiptId: nonEmptyString.optional(),
    error: nonEmptyString.optional(),
  })
  .strict();

const turnRecordSchema = z
  .object({
    turnId: middlewareIdentifier.max(256),
    input: z.json().optional(),
    output: z.json().optional(),
    contextReceiptIds: z.array(nonEmptyString).max(1_000).optional(),
    toolCalls: z.array(recordedToolCallSchema).max(100).optional(),
    metadata: z.json().optional(),
    observedAt: z.iso.datetime({ offset: true }).optional(),
    sensitivity: nonEmptyString.optional(),
    retentionPolicy: nonEmptyString.optional(),
  })
  .strict();

const runInputSchema = z
  .object({
    runId: middlewareIdentifier.max(256),
    taskId: middlewareIdentifier.max(256).optional(),
    conversationId: middlewareIdentifier.max(256).optional(),
    metadata: z.json().optional(),
    durableMetadata: z.json().optional(),
  })
  .strict();

const principalSchema = z
  .object({
    tenantId: middlewareIdentifier,
    principalId: middlewareIdentifier,
    purpose: middlewareIdentifier,
  })
  .strict();

export type AgentToolName = (typeof agentToolNames)[number];

export interface AgentToolDefinition {
  name: AgentToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface AgentToolCall {
  callId?: string;
  name: AgentToolName;
  arguments: unknown;
}

export interface AgentToolResult {
  callId: string;
  name: AgentToolName;
  result: JsonValue;
  receipt: ExecutionReceipt;
  idempotentReplay: boolean;
  modelContent: string;
}

export interface AgentRunInput {
  runId: string;
  taskId?: string;
  conversationId?: string;
  metadata?: JsonValue;
  durableMetadata?: JsonValue;
}

export interface AgentContextSearch {
  text?: string;
  predicate?: string;
  kind?:
    | "observation"
    | "reported_fact"
    | "inference"
    | "prediction"
    | "hypothesis"
    | "decision"
    | "directive"
    | "experience";
  perspective?: string;
  relatedToEntityId?: string;
  maxGraphDepth?: number;
  validAt?: string;
  systemAt?: string;
  limit?: number;
}

export interface AgentContextResolution {
  subjectEntityId: string;
  predicate: string;
  policy?: "none" | "latest" | "highest_authority";
  perspective?: string;
  validAt?: string;
  systemAt?: string;
}

export interface AgentContextTrace {
  target: LineageEndpoint;
  maxDepth?: number;
}

export interface AgentContextRequest {
  query?: string;
  search?: AgentContextSearch | false;
  resolutions?: AgentContextResolution[];
  workflow?: { instanceId: string };
  effects?: {
    instanceId?: string;
    afterEffectId?: string;
    limit?: number;
  };
  traces?: AgentContextTrace[];
  maxCharacters?: number;
}

export interface AgentContextSection {
  type: "search" | "resolution" | "workflow" | "effects" | "trace";
  key: string;
  result: JsonValue;
  receiptId: string;
}

export interface AgentContextBundle {
  runId: string;
  taskId?: string;
  conversationId?: string;
  generatedAt: string;
  query?: string;
  sections: AgentContextSection[];
  includedReceiptIds: string[];
  partialReceiptIds: string[];
  omittedReceiptIds: string[];
  modelContext: string;
  truncated: boolean;
}

export interface AgentModelInput {
  context: AgentContextBundle;
  tools: AgentToolDefinition[];
}

export interface AgentRecordedToolCall {
  name: string;
  arguments: JsonValue;
  result?: JsonValue;
  receiptId?: string;
  error?: string;
}

export interface AgentTurnRecordInput {
  turnId: string;
  input?: JsonValue;
  output?: JsonValue;
  toolCalls?: AgentRecordedToolCall[];
  contextReceiptIds?: string[];
  metadata?: JsonValue;
  observedAt?: string;
  sensitivity?: string;
  retentionPolicy?: string;
}

export interface AgentTurnRecord {
  runId: string;
  turnId: string;
  artifactId: string;
  contentHash: string;
  receipt: ExecutionReceipt;
  idempotentReplay: boolean;
}

export type AgentIntentExecutor = (
  envelope: IntentEnvelope,
) => Promise<IntentExecutionResult>;

export interface AgentDataMiddlewareConfig {
  principal: PrincipalContext;
  execute: AgentIntentExecutor;
  allowedOperations?: readonly AgentOperation["op"][];
  defaultSearchLimit?: number;
  defaultEffectLimit?: number;
  maxContextCharacters?: number;
  maxTurnCharacters?: number;
}

export interface AgentDataSession {
  identity(): PrincipalContext;
  runInfo(): AgentRunInput;
  modelTools(): AgentToolDefinition[];
  prepareModelInput(request?: AgentContextRequest): Promise<AgentModelInput>;
  compileContext(request?: AgentContextRequest): Promise<AgentContextBundle>;
  invokeTool(call: AgentToolCall): Promise<AgentToolResult>;
  execute(
    operation: AgentOperation,
    options?: {
      requestId?: string;
      idempotencyKey?: string;
    },
  ): Promise<IntentExecutionResult>;
  recordTurn(input: AgentTurnRecordInput): Promise<AgentTurnRecord>;
}

interface NormalizedMiddlewareConfig {
  principal: PrincipalContext;
  execute: AgentIntentExecutor;
  allowedOperations: ReadonlySet<AgentOperation["op"]>;
  defaultSearchLimit: number;
  defaultEffectLimit: number;
  maxContextCharacters: number;
  maxTurnCharacters: number;
}

const toolDefinitions: readonly AgentToolDefinition[] = [
  {
    name: "search_knowledge",
    title: "Search durable knowledge",
    description:
      "Retrieve bounded, tenant-scoped assertions using semantic, lexical, temporal, epistemic, and graph filters.",
    inputSchema: modelJsonSchema(searchArgumentsSchema),
    readOnly: true,
  },
  {
    name: "resolve_claims",
    title: "Resolve durable claims",
    description:
      "Read known, unknown, conflicted, or policy-selected assertions without hiding disagreement.",
    inputSchema: optionalJsonSchemaProperty(
      modelJsonSchema(resolveArgumentsSchema),
      "policy",
    ),
    readOnly: true,
  },
  {
    name: "get_machine",
    title: "Read durable workflow state",
    description:
      "Read the current state and revision of a durable workflow or retail order.",
    inputSchema: modelJsonSchema(machineArgumentsSchema),
    readOnly: true,
  },
  {
    name: "list_effects",
    title: "Read durable effect state",
    description:
      "Inspect planned, dispatching, unknown, reconciling, succeeded, failed, or cancelled effects.",
    inputSchema: modelJsonSchema(effectsArgumentsSchema),
    readOnly: true,
  },
  {
    name: "explain_trace",
    title: "Explain a durable causal trace",
    description:
      "Traverse bounded evidence, decision, policy, workflow, effect, reconciliation, and verification lineage.",
    inputSchema: modelJsonSchema(explainArgumentsSchema),
    readOnly: true,
  },
  {
    name: "execute_operation",
    title: "Execute an Agent Intent operation",
    description:
      "Execute one allowed, typed Agent Intent operation. Identity is supplied by the host and cannot be overridden by the model.",
    inputSchema: modelJsonSchema(executeArgumentsSchema),
    readOnly: false,
  },
];

export class AgentDataMiddleware {
  private readonly config: NormalizedMiddlewareConfig;

  public constructor(config: AgentDataMiddlewareConfig) {
    const principal = parseInput(principalSchema, config.principal);
    const allowedOperationNames =
      config.allowedOperations ?? safeModelOperationNames;
    const defaultOperationSet = new Set<AgentOperation["op"]>(
      safeModelOperationNames,
    );
    for (const operation of allowedOperationNames) {
      if (!defaultOperationSet.has(operation)) {
        throw new KernelError(
          "invalid_input",
          `Agent middleware cannot expose privileged operation ${operation}`,
        );
      }
    }
    this.config = {
      principal,
      execute: config.execute,
      allowedOperations: new Set(allowedOperationNames),
      defaultSearchLimit: boundedInteger(
        config.defaultSearchLimit ?? 10,
        1,
        20,
        "defaultSearchLimit",
      ),
      defaultEffectLimit: boundedInteger(
        config.defaultEffectLimit ?? 10,
        1,
        20,
        "defaultEffectLimit",
      ),
      maxContextCharacters: boundedInteger(
        config.maxContextCharacters ?? 24_000,
        1_000,
        100_000,
        "maxContextCharacters",
      ),
      maxTurnCharacters: boundedInteger(
        config.maxTurnCharacters ?? 1_000_000,
        1_000,
        10_000_000,
        "maxTurnCharacters",
      ),
    };
  }

  public beginRun(input: AgentRunInput): AgentDataSession {
    const run = parseInput(runInputSchema, input);
    return new DefaultAgentDataSession(this.config, run);
  }
}

class DefaultAgentDataSession implements AgentDataSession {
  private readonly principal: PrincipalContext;
  private readonly run: AgentRunInput;

  public constructor(
    private readonly config: NormalizedMiddlewareConfig,
    run: AgentRunInput,
  ) {
    this.principal = { ...config.principal };
    this.run = { ...run };
  }

  public identity(): PrincipalContext {
    return { ...this.principal };
  }

  public runInfo(): AgentRunInput {
    return structuredClone(this.run);
  }

  public modelTools(): AgentToolDefinition[] {
    return toolDefinitions
      .filter((definition) => {
        const operation = toolOperation(definition.name);
        return operation === null
          ? this.config.allowedOperations.size > 0
          : this.config.allowedOperations.has(operation);
      })
      .map((definition) => ({
        ...definition,
        description:
          definition.name === "execute_operation"
            ? `${definition.description} Allowed operations: ${[
                ...this.config.allowedOperations,
              ].join(", ")}.`
            : definition.description,
        inputSchema: structuredClone(definition.inputSchema),
        ...(definition.name === "execute_operation"
          ? {
              inputSchema: restrictedExecuteSchema(
                this.config.allowedOperations,
              ),
            }
          : {}),
      }));
  }

  public async prepareModelInput(
    request: AgentContextRequest = {},
  ): Promise<AgentModelInput> {
    return {
      context: await this.compileContext(request),
      tools: this.modelTools(),
    };
  }

  public async compileContext(
    request: AgentContextRequest = {},
  ): Promise<AgentContextBundle> {
    const parsed = parseInput(contextRequestSchema, request);
    const sections: AgentContextSection[] = [];

    const addSection = async (
      type: AgentContextSection["type"],
      key: string,
      operation: AgentOperation,
    ): Promise<void> => {
      const execution = await this.execute(operation);
      sections.push({
        type,
        key,
        result: execution.result,
        receiptId: execution.receipt.receiptId,
      });
    };

    if (parsed.search !== false) {
      const search = parsed.search ?? {};
      const text = search.text ?? parsed.query;
      if (text) {
        await addSection("search", text, {
          op: "search",
          ...search,
          text,
          limit: Math.min(
            search.limit ?? this.config.defaultSearchLimit,
            20,
          ),
        });
      } else if (parsed.search !== undefined) {
        throw new KernelError(
          "invalid_input",
          "Context search requires query or search.text",
        );
      }
    }

    for (const resolution of parsed.resolutions ?? []) {
      await addSection(
        "resolution",
        `${resolution.subjectEntityId}:${resolution.predicate}`,
        { op: "resolve", ...resolution },
      );
    }

    if (parsed.workflow) {
      await addSection(
        "workflow",
        parsed.workflow.instanceId,
        { op: "get_machine", ...parsed.workflow },
      );
    }

    if (parsed.effects) {
      await addSection(
        "effects",
        parsed.effects.instanceId ?? "all",
        {
          op: "list_effects",
          ...parsed.effects,
          limit: Math.min(
            parsed.effects.limit ?? this.config.defaultEffectLimit,
            20,
          ),
        },
      );
    }

    for (const trace of parsed.traces ?? []) {
      await addSection(
        "trace",
        lineageKey(trace.target),
        { op: "explain", ...trace },
      );
    }

    const generatedAt = new Date().toISOString();
    const payload = {
      runId: this.run.runId,
      ...(this.run.taskId ? { taskId: this.run.taskId } : {}),
      ...(this.run.conversationId
        ? { conversationId: this.run.conversationId }
        : {}),
      generatedAt,
      ...(parsed.query ? { query: parsed.query } : {}),
      sections: sections.map((section) => ({
        type: section.type,
        key: section.key,
        result: section.result,
        receiptId: section.receiptId,
      })),
    };
    const bounded = boundedModelContext(
      payload,
      sections,
      parsed.maxCharacters ?? this.config.maxContextCharacters,
    );
    return {
      runId: this.run.runId,
      ...(this.run.taskId ? { taskId: this.run.taskId } : {}),
      ...(this.run.conversationId
        ? { conversationId: this.run.conversationId }
        : {}),
      generatedAt,
      ...(parsed.query ? { query: parsed.query } : {}),
      sections,
      includedReceiptIds: bounded.includedReceiptIds,
      partialReceiptIds: bounded.partialReceiptIds,
      omittedReceiptIds: bounded.omittedReceiptIds,
      modelContext: bounded.text,
      truncated: bounded.truncated,
    };
  }

  public async invokeTool(call: AgentToolCall): Promise<AgentToolResult> {
    const name = parseInput(agentToolNameSchema, call.name);
    const callId = parseInput(
      middlewareIdentifier,
      call.callId ?? randomUUID(),
    );
    let operation: AgentOperation;
    let idempotencyKey: string | undefined;

    switch (name) {
      case "search_knowledge":
        operation = {
          op: "search",
          ...parseInput(searchArgumentsSchema, call.arguments),
        };
        break;
      case "resolve_claims":
        operation = {
          op: "resolve",
          ...parseInput(resolveArgumentsSchema, call.arguments),
        };
        break;
      case "get_machine":
        operation = {
          op: "get_machine",
          ...parseInput(machineArgumentsSchema, call.arguments),
        };
        break;
      case "list_effects":
        operation = {
          op: "list_effects",
          ...parseInput(effectsArgumentsSchema, call.arguments),
        };
        break;
      case "explain_trace":
        operation = {
          op: "explain",
          ...parseInput(explainArgumentsSchema, call.arguments),
        };
        break;
      case "execute_operation": {
        const parsed = parseInput(
          executeArgumentsSchema,
          call.arguments,
        );
        operation = parsed.operation;
        idempotencyKey = parsed.idempotencyKey;
        break;
      }
      default:
        return assertNever(name);
    }

    if (!this.config.allowedOperations.has(operation.op)) {
      throw new KernelError(
        "unauthorized",
        `Agent middleware does not expose ${operation.op}`,
      );
    }
    const logicalKey = idempotencyKey ?? callId;
    const toolIdentity = sha256(
      stableStringify([
        this.principal.tenantId,
        this.principal.principalId,
        this.run.runId,
        callId,
      ]),
    ).slice(0, 32);
    const execution = await this.dispatch(operation, {
      requestId: `agent-tool:${toolIdentity}`,
      idempotencyKey: this.scopedIdempotencyKey(
        "tool-call",
        logicalKey,
      ),
    });
    const modelPayload = {
      result: execution.result,
      receiptId: execution.receipt.receiptId,
      idempotentReplay: execution.idempotentReplay,
    };
    return {
      callId,
      name,
      result: execution.result,
      receipt: execution.receipt,
      idempotentReplay: execution.idempotentReplay,
      modelContent: JSON.stringify(modelPayload),
    };
  }

  public async execute(
    operation: AgentOperation,
    options: {
      requestId?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<IntentExecutionResult> {
    const parsedOperation = parseInput(agentOperationSchema, operation);
    const requestId = options.requestId
      ? parseInput(middlewareIdentifier, options.requestId)
      : `agent:${randomUUID()}`;
    const idempotencyKey = options.idempotencyKey
      ? parseInput(middlewareIdentifier, options.idempotencyKey)
      : undefined;
    return this.dispatch(parsedOperation, {
      requestId,
      idempotencyKey: idempotencyKey
        ? this.scopedIdempotencyKey(
            "host-operation",
            idempotencyKey,
          )
        : undefined,
    });
  }

  private async dispatch(
    operation: AgentOperation,
    options: {
      requestId: string;
      idempotencyKey?: string;
    },
  ): Promise<IntentExecutionResult> {
    return this.config.execute({
      protocolVersion: AGENT_INTENT_VERSION,
      requestId: options.requestId,
      ...(options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      principal: this.principal,
      operation,
    });
  }

  public async recordTurn(
    input: AgentTurnRecordInput,
  ): Promise<AgentTurnRecord> {
    const turn = parseInput(turnRecordSchema, input);
    const turnIdentity = sha256(
      stableStringify([
        this.principal.tenantId,
        this.principal.principalId,
        this.run.runId,
        turn.turnId,
      ]),
    ).slice(0, 32);
    const artifactId = `agent-turn:${turnIdentity}`;
    const content = stableStringify({
      schemaVersion: 1,
      run: {
        runId: this.run.runId,
        ...(this.run.taskId ? { taskId: this.run.taskId } : {}),
        ...(this.run.conversationId
          ? { conversationId: this.run.conversationId }
          : {}),
        ...(this.run.durableMetadata !== undefined
          ? { metadata: this.run.durableMetadata }
          : {}),
      },
      principal: this.principal,
      turn,
    });
    if (content.length > this.config.maxTurnCharacters) {
      throw new KernelError(
        "invalid_input",
        `Agent turn exceeds ${this.config.maxTurnCharacters} characters`,
      );
    }
    const execution = await this.dispatch(
      {
        op: "put_artifact",
        artifact: {
          artifactId,
          mediaType: "application/vnd.agentic-data.agent-turn+json",
          content,
          sourceIdentity: `agent:${this.principal.principalId}`,
          ...(turn.observedAt ? { observedAt: turn.observedAt } : {}),
          sensitivity: turn.sensitivity ?? "internal",
          retentionPolicy: turn.retentionPolicy ?? "agent-run",
        },
      },
      {
        requestId: `agent-turn:${turnIdentity}`,
        idempotencyKey: this.scopedIdempotencyKey(
          "turn-record",
          turn.turnId,
        ),
      },
    );
    return {
      runId: this.run.runId,
      turnId: turn.turnId,
      artifactId: resultString(execution.result, "artifactId"),
      contentHash: resultString(execution.result, "contentHash"),
      receipt: execution.receipt,
      idempotentReplay: execution.idempotentReplay,
    };
  }

  private scopedIdempotencyKey(
    domain: "host-operation" | "tool-call" | "turn-record",
    logicalKey: string,
  ): string {
    return `agent-${domain}:${sha256(
      stableStringify([
        this.principal.tenantId,
        this.principal.principalId,
        this.run.runId,
        logicalKey,
      ]),
    ).slice(0, 48)}`;
  }
}

export function createAgentDataMiddleware(
  config: AgentDataMiddlewareConfig,
): AgentDataMiddleware {
  return new AgentDataMiddleware(config);
}

export function createEmbeddedAgentMiddleware(
  kernel: AgenticKernel,
  principal: PrincipalContext,
  options: Omit<
    AgentDataMiddlewareConfig,
    "principal" | "execute"
  > = {},
): AgentDataMiddleware {
  return new AgentDataMiddleware({
    ...options,
    principal,
    execute: async (envelope) => executeIntent(kernel, envelope),
  });
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new KernelError(
      "invalid_input",
      `${field} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function boundedModelContext(
  metadata: Record<string, unknown>,
  sections: AgentContextSection[],
  maximumCharacters: number,
): {
  text: string;
  truncated: boolean;
  includedReceiptIds: string[];
  partialReceiptIds: string[];
  omittedReceiptIds: string[];
} {
  const modelSections: Array<{
    type: AgentContextSection["type"];
    key: string;
    receiptId: string;
    status: "complete" | "truncated" | "omitted";
    result?: JsonValue;
  }> = sections.map((section) => ({
    type: section.type,
    key: section.key,
    receiptId: section.receiptId,
    status: "omitted",
  }));
  const payload = { ...metadata, sections: modelSections };
  let serialized = JSON.stringify(payload, null, 2);
  if (serialized.length > maximumCharacters) {
    throw new KernelError(
      "invalid_input",
      "Context section metadata exceeds maxCharacters; request fewer sections",
    );
  }

  if (sections.length > 0) {
    const previewBudget = Math.max(
      0,
      Math.floor(
        (maximumCharacters - serialized.length) / sections.length,
      ) - 160,
    );
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      const modelSection = modelSections[index];
      if (!section || !modelSection || previewBudget === 0) {
        continue;
      }
      const result = JSON.stringify(section.result);
      modelSection.status = "truncated";
      modelSection.result = {
        truncated: true,
        originalCharacters: result.length,
        preview: result.slice(0, previewBudget),
      };
    }
    serialized = JSON.stringify(payload, null, 2);
    while (serialized.length > maximumCharacters) {
      const candidate = [...modelSections]
        .reverse()
        .find(
          (section) =>
            section.status === "truncated" &&
            section.result !== undefined,
        );
      if (!candidate) {
        break;
      }
      candidate.status = "omitted";
      delete candidate.result;
      serialized = JSON.stringify(payload, null, 2);
    }
  }

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const modelSection = modelSections[index];
    if (!section || !modelSection) {
      continue;
    }
    const priorStatus = modelSection.status;
    const priorResult = modelSection.result;
    modelSection.status = "complete";
    modelSection.result = section.result;
    const candidate = JSON.stringify(payload, null, 2);
    if (candidate.length <= maximumCharacters) {
      serialized = candidate;
      continue;
    }
    modelSection.status = priorStatus;
    modelSection.result = priorResult;
  }

  const includedReceiptIds = modelSections
    .filter((section) => section.status === "complete")
    .map((section) => section.receiptId);
  const partialReceiptIds = modelSections
    .filter((section) => section.status === "truncated")
    .map((section) => section.receiptId);
  const omittedReceiptIds = modelSections
    .filter((section) => section.status === "omitted")
    .map((section) => section.receiptId);
  return {
    text: serialized,
    truncated:
      partialReceiptIds.length > 0 || omittedReceiptIds.length > 0,
    includedReceiptIds,
    partialReceiptIds,
    omittedReceiptIds,
  };
}

function resultString(value: JsonValue, field: string): string {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    typeof value[field] !== "string"
  ) {
    throw new Error(`Agent middleware expected result field ${field}`);
  }
  return value[field];
}

function lineageKey(target: LineageEndpoint): string {
  switch (target.type) {
    case "artifact":
      return `artifact:${target.artifactId}`;
    case "assertion":
      return `assertion:${target.assertionId}`;
    case "workflow_revision":
      return `workflow:${target.instanceId}@${target.revision}`;
    case "effect":
      return `effect:${target.effectId}`;
    default:
      return assertNever(target);
  }
}

function toolOperation(
  name: AgentToolName,
): AgentOperation["op"] | null {
  switch (name) {
    case "search_knowledge":
      return "search";
    case "resolve_claims":
      return "resolve";
    case "get_machine":
      return "get_machine";
    case "list_effects":
      return "list_effects";
    case "explain_trace":
      return "explain";
    case "execute_operation":
      return null;
    default:
      return assertNever(name);
  }
}

function restrictedExecuteSchema(
  allowedOperations: ReadonlySet<AgentOperation["op"]>,
): Record<string, unknown> {
  const schema = structuredClone(
    modelJsonSchema(executeArgumentsSchema),
  );
  const properties = objectValue(schema, "properties");
  const operation = objectValue(properties, "operation");
  const variants = operation.oneOf;
  if (!Array.isArray(variants)) {
    throw new Error("Agent operation JSON Schema did not contain oneOf");
  }
  operation.oneOf = variants.filter((variant) => {
    if (!isObject(variant)) {
      return false;
    }
    const variantProperties = objectValue(variant, "properties");
    const operationName = objectValue(variantProperties, "op").const;
    const included =
      typeof operationName === "string" &&
      allowedOperations.has(operationName as AgentOperation["op"]);
    if (included) {
      normalizeOperationSchema(variant, operationName);
    }
    return included;
  });
  return schema;
}

function normalizeOperationSchema(
  variant: Record<string, unknown>,
  operationName: string,
): void {
  if (operationName === "resolve") {
    removeRequiredProperty(variant, "policy");
  }
  if (operationName === "request_payment") {
    const properties = objectValue(variant, "properties");
    const amount = objectValue(properties, "amount");
    amount.not = { enum: zeroDecimalStrings };
  }
  if (operationName === "request_effect") {
    const allOf = Array.isArray(variant.allOf)
      ? [...variant.allOf]
      : [];
    allOf.push({
      if: {
        required: ["budgetAmount"],
        properties: {
          budgetAmount: {
            not: { enum: zeroDecimalStrings },
          },
        },
      },
      then: {
        required: ["currency"],
      },
    });
    variant.allOf = allOf;
  }
}

const zeroDecimalStrings = [
  "0",
  "0.0",
  "0.00",
  "0.000",
  "0.0000",
] as const;

function optionalJsonSchemaProperty(
  schema: Record<string, unknown>,
  property: string,
): Record<string, unknown> {
  const copy = structuredClone(schema);
  removeRequiredProperty(copy, property);
  return copy;
}

function modelJsonSchema(
  schema: z.ZodType,
): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema);
  enforceNonWhitespaceStrings(jsonSchema);
  return jsonSchema;
}

function enforceNonWhitespaceStrings(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      enforceNonWhitespaceStrings(item);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  if (
    value.type === "string" &&
    typeof value.minLength === "number" &&
    value.minLength >= 1 &&
    value.pattern === undefined
  ) {
    value.pattern = "\\S";
  }
  for (const child of Object.values(value)) {
    enforceNonWhitespaceStrings(child);
  }
}

function removeRequiredProperty(
  schema: Record<string, unknown>,
  property: string,
): void {
  if (!Array.isArray(schema.required)) {
    return;
  }
  schema.required = schema.required.filter(
    (candidate) => candidate !== property,
  );
}

function objectValue(
  source: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = source[field];
  if (!isObject(value)) {
    throw new Error(`Agent JSON Schema did not contain ${field}`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function parseInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new KernelError(
      "invalid_input",
      z.prettifyError(parsed.error),
    );
  }
  return parsed.data;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported agent middleware value ${JSON.stringify(value)}`);
}
