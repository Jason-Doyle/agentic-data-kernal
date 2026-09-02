import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { SharedRemediation } from "./shared.js";
import {
  auditQuestions,
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
         effect_id, incident_id, provider_namespace, idempotency_key,
         request_hash, request, status
       ) VALUES (
         $1, $2, 'https://deployments.example.com', $3, $4, $5, 'planned'
       )`,
      [
        effectId,
        incidentId,
        idempotencyKey,
        requestHash,
        JSON.stringify(request),
      ],
    );
    await first.query(
      `INSERT INTO lineage VALUES
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
         'verification:recovery', $1, $2, 0.03
       )`,
      [incidentId, effectId],
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
          errorRate: 0.03,
        }),
      ],
    );
    await third.query("COMMIT");
    const audit = await auditBaseline(third, incidentId, effectId);
    const state = await third.query<{ state: string; status: string }>(
      `SELECT incident.state, effect.status
       FROM incidents incident
       JOIN effects effect ON effect.incident_id = incident.incident_id
       WHERE incident.incident_id = $1 AND effect.effect_id = $2`,
      [incidentId, effectId],
    );
    return {
      variant: "conventional-postgres",
      finalState: state.rows[0]?.state ?? "missing",
      effectStatus: state.rows[0]?.status ?? "missing",
      deliveryCount: options.remediation.deliveryCount,
      reconciliationCount: options.remediation.reconciliationCount,
      runtimeReloads: 2,
      auditAnswers: audit,
      durationMs: performance.now() - started,
    };
  } finally {
    await third.end();
  }
}

async function auditBaseline(
  client: Client,
  incidentId: string,
  effectId: string,
): Promise<Record<string, boolean>> {
  const counts = await client.query<{
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
       (SELECT count(*) FROM observations WHERE incident_id = $1)::TEXT
         AS observations,
       (SELECT count(*) FROM hypotheses WHERE incident_id = $1)::TEXT
         AS hypotheses,
       (
         SELECT count(*) FROM hypotheses
         WHERE incident_id = $1 AND supersedes_id IS NOT NULL
       )::TEXT AS revisions,
       (SELECT count(*) FROM decisions WHERE incident_id = $1)::TEXT
         AS decisions,
       (SELECT count(*) FROM effects WHERE effect_id = $2)::TEXT AS effects,
       (
         SELECT count(*) FROM effect_attempts WHERE effect_id = $2
       )::TEXT AS attempts,
       (
         SELECT count(*) FROM verifications WHERE effect_id = $2
       )::TEXT AS verifications,
       (SELECT terminal FROM incidents WHERE incident_id = $1) AS terminal`,
    [incidentId, effectId],
  );
  const value = counts.rows[0];
  const answered: Array<(typeof auditQuestions)[number]> = [];
  if (Number(value?.observations) >= 3) {
    answered.push("initiating observation");
  }
  if (Number(value?.hypotheses) >= 2) {
    answered.push("competing hypotheses");
  }
  if (Number(value?.revisions) >= 2) {
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
  if (Number(value?.verifications) === 1 && value?.terminal === true) {
    answered.push("verification and terminal state");
  }
  return auditMap(answered);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
