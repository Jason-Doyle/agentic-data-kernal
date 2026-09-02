import { createHash, randomUUID } from "node:crypto";
import type {
  AgentOperation,
  IntentExecutionResult,
} from "../ir.js";
import type {
  JsonValue,
} from "../types.js";
import {
  authenticateToken,
  createApiKey,
  type AuthenticatedPrincipal,
} from "./auth.js";
import { EncryptedArtifactStore } from "./artifacts.js";
import {
  type DatabaseConfig,
  type ProductionConfig,
} from "./config.js";
import { ProductionDatabase } from "./database.js";
import type {
  EmbeddingProvider,
} from "./embeddings.js";
import {
  EffectWorker,
  type EffectTransport,
} from "./effects.js";
import { ProductionKernel } from "./kernel.js";
import { createLogger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { migratePostgres } from "./migrations.js";

export interface SreScenarioOptions {
  config: ProductionConfig;
  migrationConfig: DatabaseConfig;
  runId?: string;
}

export interface SreScenarioResult {
  runId: string;
  tenantId: string;
  workflowId: string;
  decisionAssertionId: string;
  selectedHypothesisId: string;
  effectId: string;
  verificationAssertionId: string;
  finalState: string;
  terminal: boolean;
  effectStatus: string;
  resolutionStatus: string;
  deliveryCount: number;
  reconciliationCount: number;
  agentRestarts: number;
  errorRateBefore: number;
  errorRateAfter: number;
}

export async function runSreScenario(
  options: SreScenarioOptions,
): Promise<SreScenarioResult> {
  const runId = normalizeRunId(options.runId ?? randomUUID().slice(0, 8));
  const tenantId = `sre-demo-${runId}`;
  const workflowId = `incident:${runId}`;
  const principalId = `sre-agent-${runId}`;
  const purpose = "incident-response";
  const scenarioEmbeddingSpace = {
    model: "agentic-data-sre-synthetic",
    version: "1",
    dimensions: 384,
  };
  const config: ProductionConfig = {
    ...options.config,
    effectAllowedHosts: new Set([
      ...options.config.effectAllowedHosts,
      "deployments.example.com",
    ]),
    embeddingModel: scenarioEmbeddingSpace.model,
    embeddingVersion: scenarioEmbeddingSpace.version,
    embeddingDimensions: scenarioEmbeddingSpace.dimensions,
    logLevel: "silent",
  };
  await migratePostgres(
    options.migrationConfig,
    undefined,
    scenarioEmbeddingSpace,
  );

  const bootstrapDatabase = new ProductionDatabase(config);
  const key = await createApiKey(bootstrapDatabase, config, {
    tenantId,
    tenantName: `SRE Demo ${runId}`,
    principalId,
    scopes: [
      "data:read",
      "data:write",
      "effects:write",
      "workflows:run",
    ],
    purposes: [purpose],
    effectBudgetCurrency: "USD",
    effectBudgetLimit: "0",
  });
  await bootstrapDatabase.close();

  const provider = new ScenarioEmbeddingProvider(
    config.embeddingModel,
    config.embeddingVersion,
    config.embeddingDimensions,
  );
  const remediation = new SyntheticRemediationTransport();
  const errorRateBefore = remediation.errorRate;
  let decisionAssertionId = "";
  let selectedHypothesisId = "";
  let effectId = "";
  let resolutionStatus = "";

  const firstRuntime = createScenarioRuntime(config, provider);
  try {
    const principal = await authenticateToken(
      firstRuntime.database,
      config,
      key.token,
      purpose,
    );
    await execute(firstRuntime.kernel, principal, runId, "service", {
      op: "put_entity",
      entity: {
        entityId: `service:api:${runId}`,
        entityType: "service",
        canonicalName: "Checkout API",
      },
    });
    await execute(firstRuntime.kernel, principal, runId, "workflow", {
      op: "create_workflow",
      instanceId: workflowId,
      workflowType: "incident_response",
      initialState: "alerted",
      data: {
        severity: 2,
        service: `service:api:${runId}`,
        alert: "checkout error rate above threshold",
      },
    });
    await putArtifactAndObservation(firstRuntime.kernel, principal, runId, {
      artifactId: `artifact:alert:${runId}`,
      assertionId: `assertion:error-rate:${runId}`,
      predicate: "error_rate",
      value: 0.42,
      sourceIdentity: "synthetic-monitoring",
      content: JSON.stringify({
        service: "checkout-api",
        errorRate: 0.42,
        threshold: 0.05,
      }),
    });
    await putArtifactAndObservation(firstRuntime.kernel, principal, runId, {
      artifactId: `artifact:deployment:${runId}`,
      assertionId: `assertion:deployment:${runId}`,
      predicate: "deployed_version",
      value: "api-v42",
      sourceIdentity: "synthetic-deployment-events",
      content: JSON.stringify({
        deployment: "api-v42",
        minutesBeforeAlert: 3,
      }),
    });
    await putArtifactAndObservation(firstRuntime.kernel, principal, runId, {
      artifactId: `artifact:database:${runId}`,
      assertionId: `assertion:database-cpu:${runId}`,
      predicate: "database_cpu_change",
      value: 0.12,
      sourceIdentity: "synthetic-database-metrics",
      content: JSON.stringify({
        cpuChange: 0.12,
        saturation: false,
      }),
    });
    await execute(firstRuntime.kernel, principal, runId, "investigate", {
      op: "advance_workflow",
      instanceId: workflowId,
      expectedRevision: 1,
      expectedState: "alerted",
      transitionName: "collect_evidence",
      toState: "investigating",
      data: {
        severity: 2,
        observations: 3,
      },
    });

    const deploymentHypothesisV1 = `assertion:hypothesis:deployment:v1:${runId}`;
    const databaseHypothesisV1 = `assertion:hypothesis:database:v1:${runId}`;
    await assertHypothesis(firstRuntime.kernel, principal, runId, {
      assertionId: deploymentHypothesisV1,
      cause: "deployment api-v42",
      probability: 0.58,
      authority: 70,
    });
    await assertHypothesis(firstRuntime.kernel, principal, runId, {
      assertionId: databaseHypothesisV1,
      cause: "database saturation",
      probability: 0.42,
      authority: 65,
    });
    await addLineage(firstRuntime.kernel, principal, runId, "deployment-support", {
      relation: "supports",
      from: {
        type: "assertion",
        assertionId: `assertion:deployment:${runId}`,
      },
      to: { type: "assertion", assertionId: deploymentHypothesisV1 },
    });
    await addLineage(firstRuntime.kernel, principal, runId, "error-support", {
      relation: "supports",
      from: {
        type: "assertion",
        assertionId: `assertion:error-rate:${runId}`,
      },
      to: { type: "assertion", assertionId: deploymentHypothesisV1 },
    });
    await addLineage(firstRuntime.kernel, principal, runId, "database-support", {
      relation: "supports",
      from: {
        type: "assertion",
        assertionId: `assertion:database-cpu:${runId}`,
      },
      to: { type: "assertion", assertionId: databaseHypothesisV1 },
    });
    await addLineage(firstRuntime.kernel, principal, runId, "database-conflict", {
      relation: "contradicts",
      from: {
        type: "assertion",
        assertionId: `assertion:deployment:${runId}`,
      },
      to: { type: "assertion", assertionId: databaseHypothesisV1 },
    });

    selectedHypothesisId = `assertion:hypothesis:deployment:v2:${runId}`;
    const databaseHypothesisV2 = `assertion:hypothesis:database:v2:${runId}`;
    await assertHypothesis(firstRuntime.kernel, principal, runId, {
      assertionId: selectedHypothesisId,
      cause: "deployment api-v42",
      probability: 0.88,
      authority: 90,
      supersedesAssertionId: deploymentHypothesisV1,
    });
    await assertHypothesis(firstRuntime.kernel, principal, runId, {
      assertionId: databaseHypothesisV2,
      cause: "database saturation",
      probability: 0.12,
      authority: 40,
      supersedesAssertionId: databaseHypothesisV1,
    });
    const resolution = await execute(
      firstRuntime.kernel,
      principal,
      runId,
      "resolve-cause",
      {
        op: "resolve",
        subjectEntityId: `service:api:${runId}`,
        predicate: "primary_cause",
        policy: "highest_authority",
      },
    );
    const resolutionResult = objectValue(resolution.result);
    const selectedValue = resolutionResult.selected;
    if (selectedValue === undefined) {
      throw new Error("SRE scenario resolution did not select a hypothesis");
    }
    const selected = objectValue(selectedValue);
    if (selected.assertionId !== selectedHypothesisId) {
      throw new Error("SRE scenario selected the wrong hypothesis");
    }

    const policyAssertionId = `assertion:policy:${runId}`;
    decisionAssertionId = `assertion:decision:${runId}`;
    await execute(firstRuntime.kernel, principal, runId, "policy", {
      op: "assert",
      assertion: {
        assertionId: policyAssertionId,
        subjectEntityId: `service:api:${runId}`,
        predicate: "incident_remediation_policy",
        object: { type: "string", value: "incident-remediation-v2" },
        kind: "directive",
        authority: 100,
      },
    });
    await execute(firstRuntime.kernel, principal, runId, "decision", {
      op: "assert",
      assertion: {
        assertionId: decisionAssertionId,
        subjectEntityId: `service:api:${runId}`,
        predicate: "remediation",
        object: { type: "string", value: "rollback api-v42" },
        kind: "decision",
        authority: 95,
      },
    });
    await addLineage(firstRuntime.kernel, principal, runId, "decision-support", {
      relation: "supports",
      from: { type: "assertion", assertionId: selectedHypothesisId },
      to: { type: "assertion", assertionId: decisionAssertionId },
    });
    await addLineage(firstRuntime.kernel, principal, runId, "decision-policy", {
      relation: "governs",
      from: { type: "assertion", assertionId: policyAssertionId },
      to: { type: "assertion", assertionId: decisionAssertionId },
    });
    await execute(firstRuntime.kernel, principal, runId, "authorize", {
      op: "advance_workflow",
      instanceId: workflowId,
      expectedRevision: 2,
      expectedState: "investigating",
      transitionName: "authorize_remediation",
      toState: "remediation_pending",
      data: {
        selectedHypothesisId,
        decisionAssertionId,
        policyAssertionId,
      },
    });
    const effect = await execute(
      firstRuntime.kernel,
      principal,
      runId,
      "request-rollback",
      rollbackOperation(
        runId,
        workflowId,
        decisionAssertionId,
        policyAssertionId,
      ),
    );
    effectId = stringField(effect.result, "effectId");
    resolutionStatus = stringField(resolution.result, "status");
  } finally {
    await firstRuntime.database.close();
  }
  return continueAfterFirstRestart({
    config,
    provider,
    remediation,
    keyToken: key.token,
    purpose,
    runId,
    tenantId,
    workflowId,
    selectedHypothesisId,
    decisionAssertionId,
    effectId,
    resolutionStatus,
    errorRateBefore,
  });
}

async function continueAfterFirstRestart(input: {
  config: ProductionConfig;
  provider: EmbeddingProvider;
  remediation: SyntheticRemediationTransport;
  keyToken: string;
  purpose: string;
  runId: string;
  tenantId: string;
  workflowId: string;
  selectedHypothesisId: string;
  decisionAssertionId: string;
  effectId: string;
  resolutionStatus: string;
  errorRateBefore: number;
}): Promise<SreScenarioResult> {
  const secondRuntime = createScenarioRuntime(input.config, input.provider);
  try {
    await authenticateToken(
      secondRuntime.database,
      input.config,
      input.keyToken,
      input.purpose,
    );
    const worker = new EffectWorker(
      secondRuntime.database,
      input.remediation,
      { effectLeaseSeconds: 30, effectMaxAttempts: 1 },
      secondRuntime.metrics,
      secondRuntime.logger,
    );
    if (
      !(
        await worker.runOnce({
          tenantId: input.tenantId,
          effectId: input.effectId,
        })
      )
    ) {
      throw new Error("SRE remediation effect was not delivered");
    }
  } finally {
    await secondRuntime.database.close();
  }

  const thirdRuntime = createScenarioRuntime(input.config, input.provider);
  try {
    const principal = await authenticateToken(
      thirdRuntime.database,
      input.config,
      input.keyToken,
      input.purpose,
    );
    const replay = await execute(
      thirdRuntime.kernel,
      principal,
      input.runId,
      "request-rollback-after-restart",
      rollbackOperation(
        input.runId,
        input.workflowId,
        input.decisionAssertionId,
        `assertion:policy:${input.runId}`,
      ),
    );
    if (stringField(replay.result, "effectId") !== input.effectId) {
      throw new Error("Effect retry did not resolve to the original effect");
    }
    await thirdRuntime.database.withTenantTransaction(
      principal,
      (client) =>
        client.query(
          `UPDATE agentic.effect_intents
           SET next_attempt_at = clock_timestamp()
           WHERE effect_id = $1`,
          [input.effectId],
        ),
    );
    const worker = new EffectWorker(
      thirdRuntime.database,
      input.remediation,
      { effectLeaseSeconds: 30, effectMaxAttempts: 1 },
      thirdRuntime.metrics,
      thirdRuntime.logger,
    );
    if (
      !(
        await worker.runOnce({
          tenantId: input.tenantId,
          effectId: input.effectId,
        })
      )
    ) {
      throw new Error("SRE remediation effect was not reconciled");
    }
    await execute(thirdRuntime.kernel, principal, input.runId, "verify-state", {
      op: "advance_workflow",
      instanceId: input.workflowId,
      expectedRevision: 3,
      expectedState: "remediation_pending",
      transitionName: "begin_verification",
      toState: "verifying",
      data: {
        effectId: input.effectId,
        providerReference: input.remediation.providerReference,
      },
    });
    const verificationAssertionId = `assertion:verification:${input.runId}`;
    await putArtifactAndObservation(
      thirdRuntime.kernel,
      principal,
      input.runId,
      {
        artifactId: `artifact:verification:${input.runId}`,
        assertionId: verificationAssertionId,
        predicate: "error_rate",
        value: input.remediation.errorRate,
        sourceIdentity: "synthetic-post-remediation-monitoring",
        supersedesAssertionId: `assertion:error-rate:${input.runId}`,
        content: JSON.stringify({
          service: "checkout-api",
          errorRate: input.remediation.errorRate,
          baseline: 0.03,
          windowMinutes: 4,
        }),
      },
    );
    await addLineage(
      thirdRuntime.kernel,
      principal,
      input.runId,
      "effect-verification",
      {
        relation: "verifies",
        from: { type: "effect", effectId: input.effectId },
        to: {
          type: "assertion",
          assertionId: verificationAssertionId,
        },
      },
    );
    await execute(thirdRuntime.kernel, principal, input.runId, "resolve", {
      op: "advance_workflow",
      instanceId: input.workflowId,
      expectedRevision: 4,
      expectedState: "verifying",
      transitionName: "verify_remediation",
      toState: "resolved",
      data: {
        effectId: input.effectId,
        verificationAssertionId,
        errorRate: input.remediation.errorRate,
      },
      terminal: true,
    });
    if (
      await worker.runOnce({
        tenantId: input.tenantId,
        effectId: input.effectId,
      })
    ) {
      throw new Error("Terminal remediation was delivered more than once");
    }
    const workflow = await thirdRuntime.kernel.getMachineReadOnly(
      principal,
      input.workflowId,
    );
    const effects = await execute(
      thirdRuntime.kernel,
      principal,
      input.runId,
      "read-effects",
      { op: "list_effects", instanceId: input.workflowId },
    );
    const effectStatus = firstEffectStatus(effects.result);
    return {
      runId: input.runId,
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      decisionAssertionId: input.decisionAssertionId,
      selectedHypothesisId: input.selectedHypothesisId,
      effectId: input.effectId,
      verificationAssertionId,
      finalState: workflow.state,
      terminal: workflow.terminal ?? false,
      effectStatus,
      resolutionStatus: input.resolutionStatus,
      deliveryCount: input.remediation.deliveryCount,
      reconciliationCount: input.remediation.reconciliationCount,
      agentRestarts: 2,
      errorRateBefore: input.errorRateBefore,
      errorRateAfter: input.remediation.errorRate,
    };
  } finally {
    await thirdRuntime.database.close();
  }
}

function createScenarioRuntime(
  config: ProductionConfig,
  provider: EmbeddingProvider,
): {
  database: ProductionDatabase;
  kernel: ProductionKernel;
  metrics: MetricsRegistry;
  logger: ReturnType<typeof createLogger>;
} {
  const database = new ProductionDatabase(config);
  const metrics = new MetricsRegistry();
  const logger = createLogger(config);
  return {
    database,
    kernel: new ProductionKernel(
      database,
      new EncryptedArtifactStore(
        config.artifactDirectory,
        config.artifactKeyring,
      ),
      provider,
      config,
      metrics,
      logger,
    ),
    metrics,
    logger,
  };
}

async function putArtifactAndObservation(
  kernel: ProductionKernel,
  principal: AuthenticatedPrincipal,
  runId: string,
  input: {
    artifactId: string;
    assertionId: string;
    predicate: string;
    value: string | number;
    sourceIdentity: string;
    supersedesAssertionId?: string;
    content: string;
  },
): Promise<void> {
  await execute(kernel, principal, runId, `artifact-${input.assertionId}`, {
    op: "put_artifact",
    artifact: {
      artifactId: input.artifactId,
      mediaType: "application/json",
      content: input.content,
      sourceIdentity: input.sourceIdentity,
    },
  });
  await execute(kernel, principal, runId, `observation-${input.assertionId}`, {
    op: "assert",
    assertion: {
      assertionId: input.assertionId,
      subjectEntityId: `service:api:${runId}`,
      predicate: input.predicate,
      object:
        typeof input.value === "number"
          ? { type: "number", value: input.value }
          : { type: "string", value: input.value },
      kind: "observation",
      sourceArtifactId: input.artifactId,
      authority: 90,
      ...(input.supersedesAssertionId
        ? { supersedesAssertionId: input.supersedesAssertionId }
        : {}),
    },
  });
}

async function assertHypothesis(
  kernel: ProductionKernel,
  principal: AuthenticatedPrincipal,
  runId: string,
  input: {
    assertionId: string;
    cause: string;
    probability: number;
    authority: number;
    supersedesAssertionId?: string;
  },
): Promise<void> {
  await execute(kernel, principal, runId, `hypothesis-${input.assertionId}`, {
    op: "assert",
    assertion: {
      assertionId: input.assertionId,
      subjectEntityId: `service:api:${runId}`,
      predicate: "primary_cause",
      object: { type: "string", value: input.cause },
      kind: "hypothesis",
      strength: {
        type: "probability",
        value: input.probability,
        eventDefinition: "Primary cause of the active incident",
      },
      authority: input.authority,
      ...(input.supersedesAssertionId
        ? { supersedesAssertionId: input.supersedesAssertionId }
        : {}),
    },
  });
}

async function addLineage(
  kernel: ProductionKernel,
  principal: AuthenticatedPrincipal,
  runId: string,
  step: string,
  operation: Omit<
    Extract<AgentOperation, { op: "add_lineage" }>,
    "op"
  >,
): Promise<void> {
  await execute(kernel, principal, runId, step, {
    op: "add_lineage",
    ...operation,
  });
}

function rollbackOperation(
  runId: string,
  workflowId: string,
  decisionAssertionId: string,
  policyAssertionId: string,
): Extract<AgentOperation, { op: "request_effect" }> {
  return {
    op: "request_effect",
    instanceId: workflowId,
    expectedRevision: 3,
    effectName: "rollback_deployment",
    effectType: "deployment.rollback",
    target: "https://deployments.example.com/rollback",
    statusUrl: "https://deployments.example.com/status/rollback",
    request: {
      service: "checkout-api",
      deployment: "api-v42",
    },
    idempotencyKey: `rollback-api-v42-${runId}`,
    decisionAssertionId,
    policyAssertionId,
  };
}

async function execute(
  kernel: ProductionKernel,
  principal: AuthenticatedPrincipal,
  runId: string,
  step: string,
  operation: AgentOperation,
): Promise<IntentExecutionResult> {
  return kernel.execute(principal, {
    protocolVersion: "0.1",
    requestId: `${runId}-${step}-${randomUUID()}`,
    idempotencyKey: `${runId}-${step}`,
    principal: {
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      purpose: principal.purpose,
    },
    operation,
  });
}

class ScenarioEmbeddingProvider implements EmbeddingProvider {
  public constructor(
    public readonly model: string,
    public readonly version: string,
    public readonly dimensions: number,
  ) {}

  public async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array.from({ length: this.dimensions }, () => 0);
      const digest = createHash("sha256").update(text).digest();
      const index = digest.readUInt16BE(0) % this.dimensions;
      vector[index] = 1;
      return vector;
    });
  }
}

class SyntheticRemediationTransport implements EffectTransport {
  public deliveryCount = 0;
  public reconciliationCount = 0;
  public errorRate = 0.42;
  public providerReference = "";
  private applied = false;

  public async deliver(effect: {
    effectId: string;
    authorizationFence: string;
    idempotencyKey: string;
    targetUrl: string;
    request: JsonValue;
  }): Promise<{
    status: "unknown";
    responseStatus: null;
    outcome: JsonValue;
  }> {
    this.deliveryCount += 1;
    this.applied = true;
    this.errorRate = 0.03;
    this.providerReference = `synthetic-rollback-${effect.effectId}`;
    return {
      status: "unknown",
      responseStatus: null,
      outcome: {
        reason: "response_timeout_after_apply",
        idempotencyKey: effect.idempotencyKey,
      },
    };
  }

  public async reconcile(): Promise<{
    status: "succeeded";
    responseStatus: 200;
    outcome: JsonValue;
  }> {
    this.reconciliationCount += 1;
    if (!this.applied) {
      throw new Error("Cannot reconcile a remediation that was not applied");
    }
    return {
      status: "succeeded",
      responseStatus: 200,
      outcome: { providerReference: this.providerReference },
    };
  }
}

function normalizeRunId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error("SRE scenario runId must use 1 to 64 safe characters");
  }
  return value;
}

function objectValue(value: JsonValue): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Expected an object");
  }
  return value;
}

function stringField(value: JsonValue, field: string): string {
  const object = objectValue(value);
  const selected = object[field];
  if (typeof selected !== "string") {
    throw new Error(`Expected string field ${field}`);
  }
  return selected;
}

function firstEffectStatus(value: JsonValue): string {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Expected one remediation effect");
  }
  const effect = objectValue(value[0] ?? null);
  if (typeof effect.status !== "string") {
    throw new Error("Expected effect status");
  }
  return effect.status;
}
