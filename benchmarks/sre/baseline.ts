import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { SharedRemediation } from "./shared.js";
import {
  auditMap,
  type BenchmarkOutcome,
} from "./shared.js";

export async function runConventionalBaseline(options: {
  databaseUrl: string;
  runId: string;
  remediation: SharedRemediation;
}): Promise<BenchmarkOutcome> {
  const started = performance.now();
  const incidentId = `incident:${options.runId}`;
  const effectId = `effect:${options.runId}`;
  const idempotencyKey = `rollback-api-v42-${options.runId}`;
  const request = { service: "checkout-api", deployment: "api-v42" };
  const requestHash = hash(JSON.stringify(request));
  const errorRateBefore = options.remediation.errorRate;

  const first = new Client({ connectionString: options.databaseUrl });
  await first.connect();
  try {
    await first.query(
      readFileSync(
        fileURLToPath(
          new URL("./baseline-schema.sql", import.meta.url),
        ),
        "utf8",
      ),
    );
    await first.query("BEGIN");
    await first.query(
      `INSERT INTO incidents VALUES (
         $1, 'remediation_pending', 3, FALSE, $2
       )`,
      [incidentId, JSON.stringify({ severity: 2 })],
    );
    await first.query(
      `INSERT INTO observations VALUES
       ('obs:error', $1, 'error_rate', '0.42', 'monitoring'),
       ('obs:deploy', $1, 'deployed_version', '"api-v42"', 'deployments'),
       ('obs:db', $1, 'database_cpu_change', '0.12', 'database')`,
      [incidentId],
    );
    await first.query(
      `INSERT INTO hypotheses VALUES
       ('hyp:deploy:v1', $1, 'deployment api-v42', 0.58, 70, NULL, FALSE),
       ('hyp:db:v1', $1, 'database saturation', 0.42, 65, NULL, FALSE),
       ('hyp:deploy:v2', $1, 'deployment api-v42', 0.88, 90, 'hyp:deploy:v1', TRUE),
       ('hyp:db:v2', $1, 'database saturation', 0.12, 40, 'hyp:db:v1', TRUE)`,
      [incidentId],
    );
    await first.query(
      `INSERT INTO decisions VALUES (
         'decision:rollback',
         $1,
         'hyp:deploy:v2',
         'incident-remediation-v2',
         'rollback api-v42'
       )`,
      [incidentId],
    );
    await first.query(
      `INSERT INTO effects (
         effect_id, incident_id, provider_namespace, target_url, status_url,
         idempotency_key, request_hash, request, status, authorization_fence
       ) VALUES (
         $1, $2, 'https://deployments.example.com',
         'https://deployments.example.com/rollback',
         'https://deployments.example.com/status/rollback',
         $3, $4, $5, 'planned', $6
       )`,
      [
        effectId,
        incidentId,
        idempotencyKey,
        requestHash,
        JSON.stringify(request),
        `fence:${options.runId}`,
      ],
    );
    await first.query(
      `INSERT INTO lineage VALUES
       ('observation','obs:deploy','supports','hypothesis','hyp:deploy:v1'),
       ('observation','obs:error','supports','hypothesis','hyp:deploy:v1'),
       ('observation','obs:db','supports','hypothesis','hyp:db:v1'),
       ('observation','obs:deploy','contradicts','hypothesis','hyp:db:v1'),
       ('observation','obs:deploy','supports','hypothesis','hyp:deploy:v2'),
       ('observation','obs:error','supports','hypothesis','hyp:deploy:v2'),
       ('observation','obs:db','supports','hypothesis','hyp:db:v2'),
       ('observation','obs:db','contradicts','hypothesis','hyp:deploy:v2'),
       ('hypothesis','hyp:deploy:v2','supports','decision','decision:rollback'),
       ('decision','decision:rollback','authorizes','effect',$1)`,
      [effectId],
    );
    await first.query("COMMIT");
  } catch (error) {
    await first.query("ROLLBACK");
    throw error;
  } finally {
    await first.end();
  }

  const second = new Client({ connectionString: options.databaseUrl });
  await second.connect();
  try {
    const effect = await second.query<{
      status: string;
      request: { service: string; deployment: string };
    }>(
      `UPDATE effects
       SET status = 'dispatching'
       WHERE effect_id = $1 AND status = 'planned'
       RETURNING status, request`,
      [effectId],
    );
    if (!effect.rows[0]) {
      throw new Error("Baseline effect was not available for delivery");
    }
    const delivery = await options.remediation.deliver({
      effectId,
      authorizationFence: `fence:${options.runId}`,
      idempotencyKey,
      targetUrl: "https://deployments.example.com/rollback",
      request: effect.rows[0].request,
    });
    await second.query("BEGIN");
    await second.query(
      `INSERT INTO effect_attempts VALUES (
         $1, 1, 'deliver', $2, $3
       )`,
      [effectId, delivery.status, JSON.stringify(delivery.outcome)],
    );
    await second.query(
      `UPDATE effects
       SET status = 'reconciling', outcome = $2
       WHERE effect_id = $1`,
      [effectId, JSON.stringify(delivery.outcome)],
    );
    await second.query("COMMIT");
  } finally {
    await second.end();
  }

  const third = new Client({ connectionString: options.databaseUrl });
  await third.connect();
  try {
    const replay = await third.query<{
      effect_id: string;
      request_hash: string;
    }>(
      `SELECT effect_id, request_hash
       FROM effects
       WHERE provider_namespace = 'https://deployments.example.com'
         AND idempotency_key = $1`,
      [idempotencyKey],
    );
    if (
      replay.rows[0]?.effect_id !== effectId ||
      replay.rows[0]?.request_hash !== requestHash
    ) {
      throw new Error("Baseline provider idempotency replay failed");
    }
    const reconciliation = await options.remediation.reconcile({
      effectId,
      authorizationFence: `fence:${options.runId}`,
      idempotencyKey,
      statusUrl: "https://deployments.example.com/status/rollback",
    });
    const errorRateAfter = options.remediation.errorRate;
    if (!Number.isFinite(errorRateAfter) || errorRateAfter > 0.05) {
      throw new Error("Baseline remediation did not restore the error rate");
    }
    await third.query("BEGIN");
    await third.query(
      `INSERT INTO effect_attempts VALUES (
         $1, 2, 'reconcile', $2, $3
       )`,
      [
        effectId,
        reconciliation.status,
        JSON.stringify(reconciliation.outcome),
      ],
    );
    await third.query(
      `UPDATE effects
       SET status = 'succeeded', outcome = $2
       WHERE effect_id = $1`,
      [effectId, JSON.stringify(reconciliation.outcome)],
    );
    await third.query(
      `INSERT INTO verifications VALUES (
         'verification:recovery', $1, $2, $3
       )`,
      [incidentId, effectId, errorRateAfter],
    );
    await third.query(
      `INSERT INTO lineage VALUES (
         'effect', $1, 'verifies', 'verification', 'verification:recovery'
       )`,
      [effectId],
    );
    await third.query(
      `UPDATE incidents
       SET state = 'resolved', revision = 5, terminal = TRUE,
           data = $2
       WHERE incident_id = $1`,
      [
        incidentId,
        JSON.stringify({
          effectId,
          verificationId: "verification:recovery",
          errorRate: errorRateAfter,
        }),
      ],
    );
    await third.query("COMMIT");
    const audit = await auditBaseline(third, {
      incidentId,
      effectId,
      idempotencyKey,
      requestHash,
      authorizationFence: `fence:${options.runId}`,
      providerReference: options.remediation.providerReference,
      recoveredErrorRate: errorRateAfter,
    });
    const state = await third.query<{ state: string; status: string }>(
      `SELECT incident.state, effect.status
       FROM incidents incident
       JOIN effects effect ON effect.incident_id = incident.incident_id
       WHERE incident.incident_id = $1 AND effect.effect_id = $2`,
      [incidentId, effectId],
    );
    return {
      variant: "conventional-postgres",
      runId: options.runId,
      finalState: state.rows[0]?.state ?? "missing",
      effectStatus: state.rows[0]?.status ?? "missing",
      deliveryCount: options.remediation.deliveryCount,
      reconciliationCount: options.remediation.reconciliationCount,
      runtimeReloads: 2,
      errorRateBefore,
      errorRateAfter,
      auditAnswers: audit,
      durationMs: performance.now() - started,
    };
  } finally {
    await third.end();
  }
}

async function auditBaseline(
  client: Client,
  expected: {
    incidentId: string;
    effectId: string;
    idempotencyKey: string;
    requestHash: string;
    authorizationFence: string;
    providerReference: string;
    recoveredErrorRate: number;
  },
): Promise<Record<string, boolean>> {
  const audit = await client.query<{
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
       EXISTS (
         SELECT 1
         FROM observations
         WHERE observation_id = 'obs:error'
           AND incident_id = $1
           AND predicate = 'error_rate'
           AND value = '0.42'::JSONB
           AND source = 'monitoring'
       ) AS initiating_observation,
       (
         EXISTS (
           SELECT 1
           FROM hypotheses
           WHERE hypothesis_id = 'hyp:deploy:v1'
             AND incident_id = $1
             AND cause = 'deployment api-v42'
             AND probability = 0.58
             AND authority = 70
             AND supersedes_id IS NULL
             AND active = FALSE
         )
         AND EXISTS (
           SELECT 1
           FROM hypotheses
           WHERE hypothesis_id = 'hyp:db:v1'
             AND incident_id = $1
             AND cause = 'database saturation'
             AND probability = 0.42
             AND authority = 65
             AND supersedes_id IS NULL
             AND active = FALSE
         )
         AND EXISTS (
           SELECT 1
           FROM lineage
           WHERE from_type = 'observation'
             AND from_id = 'obs:deploy'
             AND relation = 'supports'
             AND to_type = 'hypothesis'
             AND to_id = 'hyp:deploy:v1'
         )
         AND EXISTS (
           SELECT 1
           FROM lineage
           WHERE from_type = 'observation'
             AND from_id = 'obs:db'
             AND relation = 'supports'
             AND to_type = 'hypothesis'
             AND to_id = 'hyp:db:v1'
         )
       ) AS competing_hypotheses,
       (
         EXISTS (
           SELECT 1
           FROM hypotheses
           WHERE hypothesis_id = 'hyp:deploy:v2'
             AND incident_id = $1
             AND cause = 'deployment api-v42'
             AND probability = 0.88
             AND authority = 90
             AND supersedes_id = 'hyp:deploy:v1'
             AND active = TRUE
         )
         AND EXISTS (
           SELECT 1
           FROM hypotheses
           WHERE hypothesis_id = 'hyp:db:v2'
             AND incident_id = $1
             AND cause = 'database saturation'
             AND probability = 0.12
             AND authority = 40
             AND supersedes_id = 'hyp:db:v1'
             AND active = TRUE
         )
         AND EXISTS (
           SELECT 1
           FROM lineage
           WHERE from_type = 'observation'
             AND from_id = 'obs:deploy'
             AND relation = 'supports'
             AND to_type = 'hypothesis'
             AND to_id = 'hyp:deploy:v2'
         )
         AND EXISTS (
           SELECT 1
           FROM lineage
           WHERE from_type = 'observation'
             AND from_id = 'obs:db'
             AND relation = 'supports'
             AND to_type = 'hypothesis'
             AND to_id = 'hyp:db:v2'
         )
         AND EXISTS (
           SELECT 1
           FROM lineage
           WHERE from_type = 'observation'
             AND from_id = 'obs:db'
             AND relation = 'contradicts'
             AND to_type = 'hypothesis'
             AND to_id = 'hyp:deploy:v2'
         )
       ) AS confidence_revisions,
       (
         EXISTS (
           SELECT 1
           FROM decisions
           WHERE decision_id = 'decision:rollback'
             AND incident_id = $1
             AND hypothesis_id = 'hyp:deploy:v2'
             AND policy = 'incident-remediation-v2'
             AND action = 'rollback api-v42'
         )
         AND EXISTS (
           SELECT 1
           FROM lineage
           WHERE from_type = 'hypothesis'
             AND from_id = 'hyp:deploy:v2'
             AND relation = 'supports'
             AND to_type = 'decision'
             AND to_id = 'decision:rollback'
         )
       ) AS selected_hypothesis_and_policy,
       EXISTS (
         SELECT 1
         FROM lineage
         WHERE from_type = 'decision'
           AND from_id = 'decision:rollback'
           AND relation = 'authorizes'
           AND to_type = 'effect'
           AND to_id = $2
       )
       AND EXISTS (
         SELECT 1
         FROM effects
         WHERE effect_id = $2
           AND incident_id = $1
           AND authorization_fence = $5
       ) AS decision_and_authorization,
       EXISTS (
         SELECT 1
         FROM effects
         WHERE effect_id = $2
           AND incident_id = $1
           AND provider_namespace = 'https://deployments.example.com'
           AND target_url = 'https://deployments.example.com/rollback'
           AND status_url =
             'https://deployments.example.com/status/rollback'
           AND idempotency_key = $3
           AND request_hash = $4
           AND request =
             '{"deployment":"api-v42","service":"checkout-api"}'::JSONB
       ) AS effect_target_and_idempotency_key,
       EXISTS (
         SELECT 1
         FROM effect_attempts
         WHERE effect_id = $2
           AND attempt_number = 1
           AND mode = 'deliver'
           AND status = 'unknown'
           AND outcome = jsonb_build_object(
             'reason', 'response_timeout_after_apply',
             'idempotencyKey', $3::TEXT
           )
       ) AS ambiguous_delivery_attempt,
       (
         EXISTS (
           SELECT 1
           FROM effect_attempts
           WHERE effect_id = $2
             AND attempt_number = 2
             AND mode = 'reconcile'
             AND status = 'succeeded'
             AND outcome = jsonb_build_object(
               'providerReference', $6::TEXT
             )
         )
         AND (
           SELECT count(*) = 2
           FROM effect_attempts
           WHERE effect_id = $2
         )
         AND EXISTS (
           SELECT 1
           FROM effects
           WHERE effect_id = $2
             AND status = 'succeeded'
             AND outcome = jsonb_build_object(
               'providerReference', $6::TEXT
             )
         )
       ) AS provider_reconciliation,
       (
         EXISTS (
           SELECT 1
           FROM verifications
           WHERE verification_id = 'verification:recovery'
             AND incident_id = $1
             AND effect_id = $2
             AND error_rate = $7
         )
         AND EXISTS (
           SELECT 1
           FROM lineage
           WHERE from_type = 'effect'
             AND from_id = $2
             AND relation = 'verifies'
             AND to_type = 'verification'
             AND to_id = 'verification:recovery'
         )
         AND EXISTS (
           SELECT 1
           FROM incidents
           WHERE incident_id = $1
             AND state = 'resolved'
             AND revision = 5
             AND terminal = TRUE
             AND data = jsonb_build_object(
               'effectId', $2::TEXT,
               'verificationId', 'verification:recovery',
               'errorRate', $7::DOUBLE PRECISION
             )
         )
       ) AS verification_and_terminal_state`,
    [
      expected.incidentId,
      expected.effectId,
      expected.idempotencyKey,
      expected.requestHash,
      expected.authorizationFence,
      expected.providerReference,
      expected.recoveredErrorRate,
    ],
  );
  const value = audit.rows[0];
  if (!value) {
    throw new Error("Conventional PostgreSQL audit query returned no result");
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
