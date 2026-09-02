import type {
  DatabaseConfig,
  ProductionConfig,
  SreRemediationTransport,
  SreScenarioResult,
} from "../../src/production/index.js";
import {
  ProductionDatabase,
  runSreScenario,
} from "../../src/production/index.js";
import {
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
    auditAnswers = await auditKernel(database, result);
  } finally {
    await database.close();
  }
  return {
    variant: "agentic-data-kernel",
    runId: result.runId,
    finalState: result.finalState,
    effectStatus: result.effectStatus,
    deliveryCount: result.deliveryCount,
    reconciliationCount: result.reconciliationCount,
    runtimeReloads: result.agentRestarts,
    errorRateBefore: result.errorRateBefore,
    errorRateAfter: result.errorRateAfter,
    auditAnswers,
    durationMs: performance.now() - started,
  };
}

async function auditKernel(
  database: ProductionDatabase,
  result: SreScenarioResult,
): Promise<Record<string, boolean>> {
  const runId = result.runId;
  const errorAssertionId = `assertion:error-rate:${runId}`;
  const deploymentAssertionId = `assertion:deployment:${runId}`;
  const databaseAssertionId = `assertion:database-cpu:${runId}`;
  const deploymentV1 = `assertion:hypothesis:deployment:v1:${runId}`;
  const databaseV1 = `assertion:hypothesis:database:v1:${runId}`;
  const deploymentV2 = `assertion:hypothesis:deployment:v2:${runId}`;
  const databaseV2 = `assertion:hypothesis:database:v2:${runId}`;
  const policyAssertionId = `assertion:policy:${runId}`;
  const decisionAssertionId = `assertion:decision:${runId}`;
  const verificationAssertionId = `assertion:verification:${runId}`;
  const idempotencyKey = `rollback-api-v42-${runId}`;
  const providerReference = `synthetic-rollback-${result.effectId}`;
  const audit = await database.query<{
    initiating_observation: boolean;
    competing_hypotheses: boolean;
    confidence_revisions: boolean;
    selected_hypothesis_and_policy: boolean;
    decision_and_authorization: boolean;
    effect_target_and_idempotency_key: boolean;
    ambiguous_delivery_attempt: boolean;
    provider_reconciliation: boolean;
    verification_and_terminal_state: boolean;
  }>(
    `SELECT
       (
         EXISTS (
           SELECT 1
           FROM agentic.assertions assertion
           JOIN agentic.artifacts artifact
             ON artifact.tenant_id = assertion.tenant_id
            AND artifact.artifact_id = assertion.source_artifact_id
           WHERE assertion.tenant_id = $1
             AND assertion.assertion_id = $4
             AND assertion.predicate = 'error_rate'
             AND assertion.kind = 'observation'
             AND assertion.object_json =
               '{"type":"number","value":0.42}'::JSONB
             AND artifact.source_identity = 'synthetic-monitoring'
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'evidence_for'
             AND from_artifact_id = $5
             AND to_assertion_id = $4
         )
       ) AS initiating_observation,
       (
         EXISTS (
           SELECT 1
           FROM agentic.assertions assertion
           JOIN agentic.artifacts artifact
             ON artifact.tenant_id = assertion.tenant_id
            AND artifact.artifact_id = assertion.source_artifact_id
           WHERE assertion.tenant_id = $1
             AND assertion.assertion_id = $6
             AND assertion.predicate = 'deployed_version'
             AND assertion.kind = 'observation'
             AND assertion.object_json =
               '{"type":"string","value":"api-v42"}'::JSONB
             AND assertion.system_to IS NULL
             AND artifact.artifact_id = $18
             AND artifact.source_identity =
               'synthetic-deployment-events'
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.assertions assertion
           JOIN agentic.artifacts artifact
             ON artifact.tenant_id = assertion.tenant_id
            AND artifact.artifact_id = assertion.source_artifact_id
           WHERE assertion.tenant_id = $1
             AND assertion.assertion_id = $10
             AND assertion.predicate = 'database_cpu_change'
             AND assertion.kind = 'observation'
             AND assertion.object_json =
               '{"type":"number","value":0.12}'::JSONB
             AND assertion.system_to IS NULL
             AND artifact.artifact_id = $19
             AND artifact.source_identity =
               'synthetic-database-metrics'
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'evidence_for'
             AND from_artifact_id = $18
             AND to_assertion_id = $6
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'evidence_for'
             AND from_artifact_id = $19
             AND to_assertion_id = $10
         )
         AND
         EXISTS (
           SELECT 1
           FROM agentic.assertions
           WHERE tenant_id = $1
             AND assertion_id = $7
             AND predicate = 'primary_cause'
             AND kind = 'hypothesis'
             AND object_json =
               '{"type":"string","value":"deployment api-v42"}'::JSONB
             AND strength_json->>'type' = 'probability'
             AND (strength_json->>'value')::DOUBLE PRECISION = 0.58
             AND authority = 70
             AND system_to IS NOT NULL
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.assertions
           WHERE tenant_id = $1
             AND assertion_id = $8
             AND predicate = 'primary_cause'
             AND kind = 'hypothesis'
             AND object_json =
               '{"type":"string","value":"database saturation"}'::JSONB
             AND strength_json->>'type' = 'probability'
             AND (strength_json->>'value')::DOUBLE PRECISION = 0.42
             AND authority = 65
             AND system_to IS NOT NULL
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'supports'
             AND from_assertion_id = $6
             AND to_assertion_id = $7
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'supports'
             AND from_assertion_id = $10
             AND to_assertion_id = $8
         )
       ) AS competing_hypotheses,
       (
         EXISTS (
           SELECT 1
           FROM agentic.assertions
           WHERE tenant_id = $1
             AND assertion_id = $9
             AND predicate = 'primary_cause'
             AND kind = 'hypothesis'
             AND object_json =
               '{"type":"string","value":"deployment api-v42"}'::JSONB
             AND supersedes_assertion_id = $7
             AND strength_json->>'type' = 'probability'
             AND (strength_json->>'value')::DOUBLE PRECISION = 0.88
             AND authority = 90
             AND status = 'active'
             AND system_to IS NULL
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.assertions
           WHERE tenant_id = $1
             AND assertion_id = $11
             AND predicate = 'primary_cause'
             AND kind = 'hypothesis'
             AND object_json =
               '{"type":"string","value":"database saturation"}'::JSONB
             AND supersedes_assertion_id = $8
             AND strength_json->>'type' = 'probability'
             AND (strength_json->>'value')::DOUBLE PRECISION = 0.12
             AND authority = 40
             AND status = 'active'
             AND system_to IS NULL
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'supports'
             AND from_assertion_id = $6
             AND to_assertion_id = $9
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'supports'
             AND from_assertion_id = $10
             AND to_assertion_id = $11
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'contradicts'
             AND from_assertion_id = $10
             AND to_assertion_id = $9
         )
       ) AS confidence_revisions,
       (
         EXISTS (
           SELECT 1
           FROM agentic.assertions
           WHERE tenant_id = $1
             AND assertion_id = $12
             AND kind = 'directive'
             AND predicate = 'incident_remediation_policy'
             AND object_json =
               '{"type":"string","value":"incident-remediation-v2"}'::JSONB
             AND authority = 100
             AND system_to IS NULL
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.assertions
           WHERE tenant_id = $1
             AND assertion_id = $13
             AND kind = 'decision'
             AND predicate = 'remediation'
             AND object_json =
               '{"type":"string","value":"rollback api-v42"}'::JSONB
             AND authority = 95
             AND system_to IS NULL
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'supports'
             AND from_assertion_id = $9
             AND to_assertion_id = $13
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'governs'
             AND from_assertion_id = $12
             AND to_assertion_id = $13
         )
       ) AS selected_hypothesis_and_policy,
       (
         EXISTS (
           SELECT 1
           FROM agentic.effect_intents effect
           JOIN agentic_auth.api_keys api_key
             ON api_key.key_id = effect.authorizing_key_id
            AND api_key.tenant_id = effect.tenant_id
           WHERE effect.tenant_id = $1
             AND effect.effect_id = $2
             AND effect.decision_assertion_id = $13
             AND effect.policy_assertion_id = $12
             AND effect.purpose = 'incident-response'
             AND effect.authorized_at IS NOT NULL
             AND effect.authorization_fence IS NOT NULL
             AND api_key.revoked_at IS NULL
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'authorizes'
             AND from_assertion_id = $13
             AND to_effect_id = $2
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'governs'
             AND from_assertion_id = $12
             AND to_effect_id = $2
         )
       ) AS decision_and_authorization,
       EXISTS (
         SELECT 1
         FROM agentic.effect_intents
         WHERE tenant_id = $1
           AND effect_id = $2
           AND instance_id = $3
           AND originating_revision = 3
           AND effect_name = 'rollback_deployment'
           AND effect_type = 'deployment.rollback'
           AND target_url = 'https://deployments.example.com/rollback'
           AND status_url =
             'https://deployments.example.com/status/rollback'
           AND provider_namespace = 'https://deployments.example.com'
           AND idempotency_key = $14
           AND request_json =
             '{"deployment":"api-v42","service":"checkout-api"}'::JSONB
           AND request_hash ~ '^[0-9a-f]{64}$'
       ) AS effect_target_and_idempotency_key,
       EXISTS (
         SELECT 1
         FROM agentic.effect_attempts
         WHERE tenant_id = $1
           AND effect_id = $2
           AND attempt_number = 1
           AND status = 'unknown'
           AND response_status IS NULL
           AND outcome_json = jsonb_build_object(
             'reason', 'response_timeout_after_apply',
             'idempotencyKey', $14::TEXT
           )
       ) AS ambiguous_delivery_attempt,
       (
         EXISTS (
           SELECT 1
           FROM agentic.effect_attempts
           WHERE tenant_id = $1
             AND effect_id = $2
             AND attempt_number = 2
             AND status = 'succeeded'
             AND response_status = 200
             AND outcome_json = jsonb_build_object(
               'providerReference', $15::TEXT
             )
         )
         AND (
           SELECT count(*) = 2
           FROM agentic.effect_attempts
           WHERE tenant_id = $1 AND effect_id = $2
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.effect_intents
           WHERE tenant_id = $1
             AND effect_id = $2
             AND status = 'succeeded'
             AND attempt_count = 1
             AND reconciliation_count = 1
             AND outcome_json = jsonb_build_object(
               'providerReference', $15::TEXT
             )
         )
       ) AS provider_reconciliation,
       (
         EXISTS (
           SELECT 1
           FROM agentic.assertions assertion
           JOIN agentic.artifacts artifact
             ON artifact.tenant_id = assertion.tenant_id
            AND artifact.artifact_id = assertion.source_artifact_id
           WHERE assertion.tenant_id = $1
             AND assertion.assertion_id = $16
             AND assertion.predicate = 'error_rate'
             AND assertion.kind = 'observation'
             AND assertion.object_json =
               '{"type":"number","value":0.03}'::JSONB
             AND assertion.supersedes_assertion_id = $4
             AND assertion.system_to IS NULL
             AND artifact.artifact_id = $17
             AND artifact.source_identity =
               'synthetic-post-remediation-monitoring'
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.lineage_edges
           WHERE tenant_id = $1
             AND relation = 'verifies'
             AND from_effect_id = $2
             AND to_assertion_id = $16
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.machine_instances
           WHERE tenant_id = $1
             AND instance_id = $3
             AND machine_type = 'incident_response'
             AND state = 'resolved'
             AND revision = 5
             AND terminal = TRUE
             AND data_json = jsonb_build_object(
               'effectId', $2::TEXT,
               'verificationAssertionId', $16::TEXT,
               'errorRate', 0.03
             )
         )
         AND EXISTS (
           SELECT 1
           FROM agentic.machine_history
           WHERE tenant_id = $1
             AND instance_id = $3
             AND revision = 5
             AND transition_name = 'verify_remediation'
             AND prior_state = 'verifying'
             AND new_state = 'resolved'
         )
       ) AS verification_and_terminal_state`,
    [
      result.tenantId,
      result.effectId,
      result.workflowId,
      errorAssertionId,
      `artifact:alert:${runId}`,
      deploymentAssertionId,
      deploymentV1,
      databaseV1,
      deploymentV2,
      databaseAssertionId,
      databaseV2,
      policyAssertionId,
      decisionAssertionId,
      idempotencyKey,
      providerReference,
      verificationAssertionId,
      `artifact:verification:${runId}`,
      `artifact:deployment:${runId}`,
      `artifact:database:${runId}`,
    ],
  );
  const value = audit.rows[0];
  if (!value) {
    throw new Error("Agentic Data Kernel audit query returned no result");
  }
  return auditMap({
    "initiating observation": value.initiating_observation,
    "competing hypotheses": value.competing_hypotheses,
    "confidence revisions": value.confidence_revisions,
    "selected hypothesis and policy":
      value.selected_hypothesis_and_policy,
    "decision and authorization": value.decision_and_authorization,
    "effect target and idempotency key":
      value.effect_target_and_idempotency_key,
    "ambiguous delivery attempt": value.ambiguous_delivery_attempt,
    "provider reconciliation": value.provider_reconciliation,
    "verification and terminal state":
      value.verification_and_terminal_state,
  });
}
