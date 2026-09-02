import type {
  SreRemediationTransport,
} from "../../src/production/index.js";

export const auditQuestions = [
  "initiating observation",
  "competing hypotheses",
  "confidence revisions",
  "selected hypothesis and policy",
  "decision and authorization",
  "effect target and idempotency key",
  "ambiguous delivery attempt",
  "provider reconciliation",
  "verification and terminal state",
] as const;

export type AuditQuestion = (typeof auditQuestions)[number];

export interface BenchmarkOutcome {
  variant: "conventional-postgres" | "agentic-data-kernel";
  finalState: string;
  effectStatus: string;
  deliveryCount: number;
  reconciliationCount: number;
  runtimeReloads: number;
  auditAnswers: Record<string, boolean>;
  durationMs: number;
}

export interface BenchmarkMeasurement {
  outcome: BenchmarkOutcome;
  operatedTables: number;
  databaseBytes: number;
}

export function assertCorrectness(outcome: BenchmarkOutcome): void {
  if (
    outcome.finalState !== "resolved" ||
    outcome.effectStatus !== "succeeded" ||
    outcome.deliveryCount !== 1 ||
    outcome.reconciliationCount !== 1 ||
    outcome.runtimeReloads !== 2 ||
    auditQuestions.some((question) => outcome.auditAnswers[question] !== true)
  ) {
    throw new Error(
      `${outcome.variant} failed the shared SRE behavior contract`,
    );
  }
}

export function auditMap(
  answers: Record<AuditQuestion, boolean>,
): Record<string, boolean> {
  return Object.fromEntries(
    auditQuestions.map((question) => [question, answers[question]]),
  );
}

export type SharedRemediation = SreRemediationTransport;
