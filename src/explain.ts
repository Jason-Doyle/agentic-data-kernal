import type {
  JsonValue,
  LineageEndpoint,
  TraceExplanation,
} from "./types.js";

export function summarizeTraceJson(
  value: JsonValue,
  maximumCharacters = 8_000,
): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maximumCharacters) {
    return value;
  }
  return {
    truncated: true,
    characters: serialized.length,
    preview: serialized.slice(0, maximumCharacters),
  };
}

export function traceEndpointKey(endpoint: LineageEndpoint): string {
  switch (endpoint.type) {
    case "artifact":
      return `artifact:${endpoint.artifactId}`;
    case "assertion":
      return `assertion:${endpoint.assertionId}`;
    case "workflow_revision":
      return `workflow:${endpoint.instanceId}@${endpoint.revision}`;
    case "effect":
      return `effect:${endpoint.effectId}`;
  }
}

export function parseTraceEndpoint(
  type: string,
  id: string,
  revision?: string,
): LineageEndpoint {
  switch (type) {
    case "artifact":
      return { type, artifactId: id };
    case "assertion":
      return { type, assertionId: id };
    case "effect":
      return { type, effectId: id };
    case "workflow_revision": {
      const parsedRevision = Number(revision);
      if (!Number.isInteger(parsedRevision) || parsedRevision <= 0) {
        throw new Error(
          "--revision must be a positive integer for workflow_revision",
        );
      }
      return { type, instanceId: id, revision: parsedRevision };
    }
    default:
      throw new Error(
        "--type must be artifact, assertion, workflow_revision, or effect",
      );
  }
}

export function normalizeTraceDepth(value = 4): number {
  if (!Number.isInteger(value) || value < 0 || value > 8) {
    throw new Error("Trace depth must be an integer from 0 to 8");
  }
  return value;
}

export function formatTraceExplanation(
  explanation: TraceExplanation,
): string {
  const lines = [
    `Trace: ${terminalSafe(displayTraceEndpoint(explanation.root))}`,
    "",
    "Nodes:",
  ];
  for (const node of explanation.nodes) {
    lines.push(
      `${"  ".repeat(node.depth)}[${node.depth}] ${terminalSafe(node.label)} (${terminalSafe(displayTraceEndpoint(node.ref))})`,
    );
    for (const attempt of traceAttemptSummaries(node.record)) {
      lines.push(
        `${"  ".repeat(node.depth + 1)}attempt ${attempt.number}: ${terminalSafe(attempt.status)}${attempt.responseStatus === null ? "" : ` HTTP ${attempt.responseStatus}`} at ${terminalSafe(attempt.createdAt)}`,
      );
    }
  }
  lines.push("", "Links:");
  for (const edge of explanation.edges) {
    lines.push(
      `  ${terminalSafe(displayTraceEndpoint(edge.from))} --${terminalSafe(edge.relation)}--> ${terminalSafe(displayTraceEndpoint(edge.to))}`,
    );
  }
  if (explanation.truncated) {
    lines.push("", "Trace truncated at the configured node limit.");
  }
  return lines.join("\n");
}

function displayTraceEndpoint(endpoint: LineageEndpoint): string {
  switch (endpoint.type) {
    case "artifact":
      return endpoint.artifactId;
    case "assertion":
      return endpoint.assertionId;
    case "workflow_revision":
      return `${endpoint.instanceId}@${endpoint.revision}`;
    case "effect":
      return endpoint.effectId;
  }
}

function terminalSafe(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function traceAttemptSummaries(record: JsonValue): Array<{
  number: number;
  status: string;
  responseStatus: number | null;
  createdAt: string;
}> {
  if (
    record === null ||
    Array.isArray(record) ||
    typeof record !== "object" ||
    !Array.isArray(record.attempts)
  ) {
    return [];
  }
  return record.attempts.flatMap((attempt) => {
    if (
      attempt === null ||
      Array.isArray(attempt) ||
      typeof attempt !== "object" ||
      typeof attempt.attemptNumber !== "number" ||
      typeof attempt.status !== "string" ||
      (
        attempt.responseStatus !== null &&
        typeof attempt.responseStatus !== "number"
      ) ||
      typeof attempt.createdAt !== "string"
    ) {
      return [];
    }
    return [{
      number: attempt.attemptNumber,
      status: attempt.status,
      responseStatus: attempt.responseStatus,
      createdAt: attempt.createdAt,
    }];
  });
}
