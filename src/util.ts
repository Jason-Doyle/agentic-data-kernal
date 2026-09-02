import { createHash } from "node:crypto";
import type { JsonValue, TypedValue } from "./types.js";

export function sha256(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function normalizeIsoTimestamp(
  value: string,
  fieldName: string,
): string {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`${fieldName} must be a valid ISO-8601 timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((token) => token.length > 1) ?? [];
}

export function lexicalScore(query: string, candidate: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) {
    return 0;
  }
  const candidateTokens = new Set(tokenize(candidate));
  let matches = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / queryTokens.size;
}

export function hashEmbedding(text: string, dimensions = 64): number[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const vector = Array.from({ length: dimensions }, () => 0);
  for (const [token, count] of counts) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt16BE(0) % dimensions;
    const sign = (digest[2] ?? 0) % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * (1 + Math.log(count));
  }

  const magnitude = Math.sqrt(
    vector.reduce((sum, component) => sum + component * component, 0),
  );
  return magnitude === 0
    ? vector
    : vector.map((component) => component / magnitude);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function typedValueText(value: TypedValue): string {
  switch (value.type) {
    case "string":
    case "timestamp":
    case "entity":
      return value.value;
    case "number":
      return value.unit ? `${value.value} ${value.unit}` : String(value.value);
    case "boolean":
      return String(value.value);
    case "json":
      return stableStringify(value.value);
  }
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
