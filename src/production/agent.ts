import * as z from "zod/v4";
import { isIP } from "node:net";
import {
  AgentDataMiddleware,
  type AgentDataMiddlewareConfig,
} from "../agent.js";
import type { IntentExecutionResult } from "../ir.js";
import type { PrincipalContext } from "../types.js";
import { sha256, stableStringify } from "../util.js";
import { SUPPORTED_AGENT_INTENT_VERSIONS } from "../version.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import type { ProductionKernel } from "./kernel.js";

const receiptSchema = z
  .object({
    tenantId: z.string().min(1),
    receiptId: z.string().min(1),
    requestId: z.string().min(1),
    principalId: z.string().min(1),
    purpose: z.string().min(1),
    operation: z.string().min(1),
    snapshotTime: z.iso.datetime({ offset: true }),
    evidenceManifest: z.json(),
    resultHash: z.string().regex(/^[a-f0-9]{64}$/),
    result: z.json(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const executionResultSchema = z
  .object({
    protocolVersion: z.enum(SUPPORTED_AGENT_INTENT_VERSIONS),
    requestId: z.string().min(1),
    status: z.literal("ok"),
    operation: z.string().min(1),
    result: z.json(),
    receipt: receiptSchema,
    idempotentReplay: z.boolean(),
  })
  .passthrough();

const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict(),
    requestId: z.string().optional(),
  })
  .strict();

type MiddlewareOptions = Omit<
  AgentDataMiddlewareConfig,
  "principal" | "execute"
>;

export interface ProductionHttpAgentMiddlewareConfig
  extends MiddlewareOptions {
  baseUrl: string;
  apiKey: string;
  principal: PrincipalContext;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

export class AgentDataHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "AgentDataHttpError";
  }
}

export function createProductionAgentMiddleware(
  kernel: ProductionKernel,
  principal: AuthenticatedPrincipal,
  options: MiddlewareOptions = {},
): AgentDataMiddleware {
  return new AgentDataMiddleware({
    ...options,
    principal: {
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      purpose: principal.purpose,
    },
    execute: (envelope) => kernel.execute(principal, envelope),
  });
}

export function createProductionHttpAgentMiddleware(
  config: ProductionHttpAgentMiddlewareConfig,
): AgentDataMiddleware {
  const endpoint = executionEndpoint(config.baseUrl);
  const apiKey = z.string().min(1).parse(config.apiKey);
  const requestTimeoutMs = boundedInteger(
    config.requestTimeoutMs ?? 30_000,
    1_000,
    120_000,
    "requestTimeoutMs",
  );
  const maxResponseBytes = boundedInteger(
    config.maxResponseBytes ?? 10_000_000,
    1_024,
    10_000_000,
    "maxResponseBytes",
  );
  const fetchImplementation = config.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("A Fetch API implementation is required");
  }
  const {
    baseUrl: _baseUrl,
    apiKey: _apiKey,
    principal,
    fetch: _fetch,
    requestTimeoutMs: _requestTimeoutMs,
    maxResponseBytes: _maxResponseBytes,
    ...options
  } = config;
  return new AgentDataMiddleware({
    ...options,
    principal,
    execute: async (envelope) => {
      let response: Response;
      let text: string;
      try {
        response = await fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            authorization: ["Bearer", apiKey].join(" "),
            "content-type": "application/json",
            "x-agent-purpose": principal.purpose,
          },
          body: JSON.stringify(envelope),
          redirect: "error",
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        text = await readLimitedBody(response, maxResponseBytes);
      } catch (error) {
        if (error instanceof AgentDataHttpError) {
          throw error;
        }
        const timeout =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        throw new AgentDataHttpError(
          timeout ? 504 : 0,
          timeout ? "timeout" : "network_error",
          timeout
            ? "Agentic Data Kernel HTTP request timed out"
            : "Agentic Data Kernel HTTP request failed",
        );
      }
      const body = parseJson(text);
      if (!response.ok) {
        const parsedError = errorResponseSchema.safeParse(body);
        if (parsedError.success) {
          throw new AgentDataHttpError(
            response.status,
            parsedError.data.error.code,
            parsedError.data.error.message,
            parsedError.data.requestId,
          );
        }
        throw new AgentDataHttpError(
          response.status,
          "http_error",
          `Agentic Data Kernel returned HTTP ${response.status}`,
        );
      }
      const parsed = executionResultSchema.safeParse(body);
      if (!parsed.success) {
        throw new AgentDataHttpError(
          response.status,
          "invalid_response",
          "Agentic Data Kernel returned an invalid execution response",
        );
      }
      assertCorrelatedResponse(parsed.data, envelope);
      return {
        ...parsed.data,
        operation: envelope.operation.op,
      };
    },
  });
}

function executionEndpoint(baseUrl: string): URL {
  const url = new URL(z.string().url().parse(baseUrl));
  if (url.username || url.password) {
    throw new Error("Agent middleware baseUrl must not contain credentials");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHost(url.hostname))
  ) {
    throw new Error(
      "Agent middleware HTTP requires HTTPS except for loopback development",
    );
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return new URL("v1/execute", url);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  return (
    isIP(normalized) === 4 &&
    normalized.split(".")[0] === "127"
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function readLimitedBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new AgentDataHttpError(
        response.status,
        "response_too_large",
        `Agentic Data Kernel HTTP response exceeded ${maximumBytes} bytes`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertCorrelatedResponse(
  response: z.infer<typeof executionResultSchema>,
  envelope: Parameters<AgentDataMiddlewareConfig["execute"]>[0],
): void {
  const mismatched =
    response.protocolVersion !== envelope.protocolVersion ||
    response.requestId !== envelope.requestId ||
    response.operation !== envelope.operation.op ||
    response.receipt.tenantId !== envelope.principal.tenantId ||
    response.receipt.principalId !== envelope.principal.principalId ||
    response.receipt.purpose !== envelope.principal.purpose ||
    response.receipt.operation !== envelope.operation.op ||
    (
      !response.idempotentReplay &&
      response.receipt.requestId !== envelope.requestId
    ) ||
    stableStringify(response.receipt.result) !==
      stableStringify(response.result) ||
    response.receipt.resultHash !==
      sha256(stableStringify(response.result));
  if (mismatched) {
    throw new AgentDataHttpError(
      502,
      "response_mismatch",
      "Agentic Data Kernel response did not match the request identity",
    );
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${field} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}
