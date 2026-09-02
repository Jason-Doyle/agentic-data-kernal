import * as z from "zod/v4";
import {
  AgenticKernel,
  jsonResult,
  KernelError,
  operationEvidence,
} from "./kernel.js";
import type { ExecutionReceipt, JsonValue } from "./types.js";
import { sha256, stableStringify } from "./util.js";

const nonEmptyString = z.string().trim().min(1);
const isoTimestamp = z.iso.datetime({ offset: true });

const principalSchema = z
  .object({
    tenantId: nonEmptyString,
    principalId: nonEmptyString,
    purpose: nonEmptyString,
  })
  .strict();

const typedValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), value: z.string() }).strict(),
  z
    .object({
      type: z.literal("number"),
      value: z.number().finite(),
      unit: z.string().trim().min(1).optional(),
    })
    .strict(),
  z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
  z
    .object({ type: z.literal("timestamp"), value: isoTimestamp })
    .strict(),
  z.object({ type: z.literal("entity"), value: nonEmptyString }).strict(),
  z.object({ type: z.literal("json"), value: z.json() }).strict(),
]);

const strengthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("rank"),
      value: z.enum(["preferred", "normal", "deprecated"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("probability"),
      value: z.number().min(0).max(1),
      calibrationRef: nonEmptyString.optional(),
      eventDefinition: nonEmptyString.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("interval"),
      low: z.number().finite(),
      high: z.number().finite(),
      method: nonEmptyString,
    })
    .strict(),
  z
    .object({
      type: z.literal("evidence_count"),
      supporting: z.number().int().nonnegative(),
      considered: z.number().int().nonnegative(),
    })
    .strict(),
]);

const epistemicKindSchema = z.enum([
  "observation",
  "reported_fact",
  "inference",
  "prediction",
  "hypothesis",
  "decision",
  "directive",
  "experience",
]);

const assertionSchema = z
  .object({
    assertionId: nonEmptyString.optional(),
    subjectEntityId: nonEmptyString,
    predicate: nonEmptyString,
    object: typedValueSchema,
    kind: epistemicKindSchema,
    perspective: nonEmptyString.optional(),
    validFrom: isoTimestamp.optional(),
    validTo: isoTimestamp.optional(),
    strength: strengthSchema.optional(),
    authority: z.number().int().min(0).max(100).optional(),
    status: z.enum(["active", "disputed"]).optional(),
    sourceArtifactId: nonEmptyString.optional(),
    basis: z.json().optional(),
    supersedesAssertionId: nonEmptyString.optional(),
  })
  .strict();

export const agentOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("put_entity"),
      entity: z
        .object({
          entityId: nonEmptyString,
          entityType: nonEmptyString,
          canonicalName: nonEmptyString,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("put_artifact"),
      artifact: z
        .object({
          artifactId: nonEmptyString.optional(),
          mediaType: nonEmptyString,
          content: nonEmptyString,
          sourceIdentity: nonEmptyString,
          observedAt: isoTimestamp.optional(),
          sensitivity: nonEmptyString.optional(),
          retentionPolicy: nonEmptyString.optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ op: z.literal("assert"), assertion: assertionSchema }).strict(),
  z
    .object({
      op: z.literal("resolve"),
      subjectEntityId: nonEmptyString,
      predicate: nonEmptyString,
      policy: z
        .enum(["none", "latest", "highest_authority"])
        .default("none"),
      perspective: nonEmptyString.optional(),
      validAt: isoTimestamp.optional(),
      systemAt: isoTimestamp.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("search"),
      text: nonEmptyString,
      predicate: nonEmptyString.optional(),
      kind: epistemicKindSchema.optional(),
      perspective: nonEmptyString.optional(),
      relatedToEntityId: nonEmptyString.optional(),
      maxGraphDepth: z.number().int().min(0).max(8).optional(),
      validAt: isoTimestamp.optional(),
      systemAt: isoTimestamp.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("seed_inventory"),
      sku: nonEmptyString,
      location: nonEmptyString,
      quantityOnHand: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      op: z.literal("reserve_inventory"),
      orderId: nonEmptyString,
      sku: nonEmptyString,
      location: nonEmptyString,
      quantity: z.number().int().positive(),
      holdSeconds: z.number().int().positive().max(86_400),
      idempotencyKey: nonEmptyString,
    })
    .strict(),
  z
    .object({
      op: z.literal("request_payment"),
      instanceId: nonEmptyString,
      amount: z.number().positive(),
      currency: z.string().trim().regex(/^[A-Z]{3}$/),
      paymentTarget: nonEmptyString,
      idempotencyKey: nonEmptyString,
    })
    .strict(),
  z
    .object({
      op: z.literal("record_payment_outcome"),
      effectId: nonEmptyString,
      idempotencyKey: nonEmptyString,
      status: z.enum(["succeeded", "failed", "unknown"]),
      outcome: z.json().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("get_machine"),
      instanceId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      op: z.literal("list_effects"),
      instanceId: nonEmptyString.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("process_timers"),
      asOf: isoTimestamp.optional(),
    })
    .strict(),
]);

export const intentEnvelopeSchema = z
  .object({
    protocolVersion: z.literal("0.1"),
    requestId: nonEmptyString,
    idempotencyKey: nonEmptyString.optional(),
    principal: principalSchema,
    operation: agentOperationSchema,
  })
  .strict();

export type AgentOperation = z.infer<typeof agentOperationSchema>;
export type IntentEnvelope = z.infer<typeof intentEnvelopeSchema>;

export interface IntentExecutionResult {
  protocolVersion: "0.1";
  requestId: string;
  status: "ok";
  operation: AgentOperation["op"];
  result: JsonValue;
  receipt: ExecutionReceipt;
  idempotentReplay: boolean;
}

export function parseIntentEnvelope(input: unknown): IntentEnvelope {
  const parsed = intentEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new KernelError(
      "invalid_input",
      z.prettifyError(parsed.error),
    );
  }
  return parsed.data;
}

export function executeIntent(
  kernel: AgenticKernel,
  input: unknown,
): IntentExecutionResult {
  const envelope = parseIntentEnvelope(input);
  const operationKey = `intent:${envelope.principal.principalId}:${
    envelope.idempotencyKey ?? envelope.requestId
  }`;
  const requestHash = sha256(
    stableStringify({
      principal: envelope.principal,
      operation: envelope.operation,
    }),
  );

  return kernel.transaction(() => {
    const replay = kernel.getIdempotency<IntentExecutionResult>(
      envelope.principal.tenantId,
      operationKey,
      requestHash,
    );
    if (replay) {
      return { ...replay, idempotentReplay: true };
    }

    const rawResult = executeOperation(kernel, envelope);
    const result = jsonResult(rawResult);
    const evidence = operationEvidence(rawResult);
    const receipt = kernel.recordReceipt(
      envelope.principal,
      envelope.requestId,
      envelope.operation.op,
      result,
      evidence,
    );
    const response: IntentExecutionResult = {
      protocolVersion: "0.1",
      requestId: envelope.requestId,
      status: "ok",
      operation: envelope.operation.op,
      result,
      receipt,
      idempotentReplay: false,
    };
    kernel.putIdempotency(
      envelope.principal.tenantId,
      operationKey,
      requestHash,
      response,
    );
    return response;
  });
}

function executeOperation(
  kernel: AgenticKernel,
  envelope: IntentEnvelope,
): unknown {
  const { operation, principal } = envelope;
  switch (operation.op) {
    case "put_entity":
      return kernel.putEntity(principal, operation.entity);
    case "put_artifact":
      return kernel.putArtifact(principal, operation.artifact);
    case "assert":
      return kernel.assert(principal, operation.assertion);
    case "resolve":
      return kernel.resolve(
        principal.tenantId,
        operation.subjectEntityId,
        operation.predicate,
        operation.policy,
        {
          perspective: operation.perspective,
          validAt: operation.validAt,
          systemAt: operation.systemAt,
        },
      );
    case "search":
      return kernel.search(principal.tenantId, {
        text: operation.text,
        predicate: operation.predicate,
        kind: operation.kind,
        perspective: operation.perspective,
        relatedToEntityId: operation.relatedToEntityId,
        maxGraphDepth: operation.maxGraphDepth,
        validAt: operation.validAt,
        systemAt: operation.systemAt,
        limit: operation.limit,
      });
    case "seed_inventory":
      return kernel.seedInventory(
        principal,
        operation.sku,
        operation.location,
        operation.quantityOnHand,
      );
    case "reserve_inventory":
      return kernel.reserveInventory(principal, operation);
    case "request_payment":
      return kernel.requestPayment(principal, operation);
    case "record_payment_outcome":
      return kernel.recordPaymentOutcome(principal, operation);
    case "get_machine":
      return kernel.getMachine(principal.tenantId, operation.instanceId);
    case "list_effects":
      return kernel.listEffects(principal.tenantId, operation.instanceId);
    case "process_timers":
      return kernel.processDueTimers(principal, operation.asOf);
  }
}
