import type {
  DatabaseConfig,
  ProductionConfig,
  SreRemediationTransport,
} from "../../src/production/index.js";
import {
  ProductionDatabase,
  runSreScenario,
} from "../../src/production/index.js";
import {
  auditQuestions,
  auditMap,
  type BenchmarkOutcome,
} from "./shared.js";

export async function runKernelVariant(options: {
  config: ProductionConfig;
  migrationConfig: DatabaseConfig;
  runId: string;
  remediation: SreRemediationTransport;
}): Promise<BenchmarkOutcome> {
  const started = performance.now();
  const result = await runSreScenario(options);
  const database = new ProductionDatabase(options.migrationConfig);
  let auditAnswers: Record<string, boolean>;
  try {
    const counts = await database.query<{
      observations: string;
      hypotheses: string;
      revisions: string;
      decisions: string;
      effects: string;
      attempts: string;
      verifications: string;
      terminal: boolean;
    }>(
      `SELECT
         (
           SELECT count(*) FROM agentic.assertions
           WHERE tenant_id = $1 AND kind = 'observation'
         )::TEXT AS observations,
         (
           SELECT count(*) FROM agentic.assertions
           WHERE tenant_id = $1 AND kind = 'hypothesis'
         )::TEXT AS hypotheses,
         (
           SELECT count(*) FROM agentic.assertions
           WHERE tenant_id = $1 AND supersedes_assertion_id IS NOT NULL
         )::TEXT AS revisions,
         (
           SELECT count(*) FROM agentic.assertions
           WHERE tenant_id = $1 AND kind = 'decision'
         )::TEXT AS decisions,
         (
           SELECT count(*) FROM agentic.effect_intents
           WHERE tenant_id = $1 AND effect_id = $2
         )::TEXT AS effects,
         (
           SELECT count(*) FROM agentic.effect_attempts
           WHERE tenant_id = $1 AND effect_id = $2
         )::TEXT AS attempts,
         (
           SELECT count(*) FROM agentic.lineage_edges
           WHERE tenant_id = $1 AND relation = 'verifies'
         )::TEXT AS verifications,
         (
           SELECT terminal FROM agentic.machine_instances
           WHERE tenant_id = $1 AND instance_id = $3
         ) AS terminal`,
      [result.tenantId, result.effectId, result.workflowId],
    );
    const value = counts.rows[0];
    const answered: Array<(typeof auditQuestions)[number]> = [];
    if (Number(value?.observations) >= 4) {
      answered.push("initiating observation");
    }
    if (Number(value?.hypotheses) >= 4) {
      answered.push("competing hypotheses");
    }
    if (Number(value?.revisions) >= 3) {
      answered.push("confidence revisions");
    }
    if (Number(value?.decisions) === 1) {
      answered.push("selected hypothesis and policy");
      answered.push("decision and authorization");
    }
    if (Number(value?.effects) === 1) {
      answered.push("effect target and idempotency key");
    }
    if (Number(value?.attempts) === 2) {
      answered.push("ambiguous delivery attempt");
      answered.push("provider reconciliation");
    }
    if (Number(value?.verifications) >= 1 && value?.terminal === true) {
      answered.push("verification and terminal state");
    }
    auditAnswers = auditMap(answered);
  } finally {
    await database.close();
  }
  return {
    variant: "agentic-data-kernel",
    finalState: result.finalState,
    effectStatus: result.effectStatus,
    deliveryCount: result.deliveryCount,
    reconciliationCount: result.reconciliationCount,
    runtimeReloads: result.agentRestarts,
    auditAnswers,
    durationMs: performance.now() - started,
  };
}
