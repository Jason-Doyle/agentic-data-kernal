import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { toSql as vectorToSql } from "pgvector";
import type { PoolClient, QueryResultRow } from "pg";
import {
  jsonResult,
  KernelError,
  operationEvidence,
} from "../kernel.js";
import {
  parseIntentEnvelope,
  type AgentOperation,
  type IntentExecutionResult,
} from "../ir.js";
import type {
  AssertionRecord,
  EffectRecord,
  EpistemicKind,
  InventoryRecord,
  JsonValue,
  MachineRecord,
  MachineState,
  OrderData,
  ResolutionPolicy,
  ResolutionResult,
  SearchHit,
  Strength,
  TypedValue,
} from "../types.js";
import {
  normalizeIsoTimestamp,
  sha256,
  stableStringify,
  toJsonValue,
  typedValueText,
} from "../util.js";
import type { EncryptedArtifactStore, StoredArtifact } from "./artifacts.js";
import {
  operationScope,
  requireScope,
  type AuthenticatedPrincipal,
} from "./auth.js";
import type { ProductionConfig } from "./config.js";
import type { ProductionDatabase } from "./database.js";
import {
  embeddingSpace as describeEmbeddingSpace,
  type EmbeddingProvider,
  type EmbeddingSpace,
  validateEmbeddingVector,
} from "./embeddings.js";
import type { MetricsRegistry } from "./metrics.js";
import { buildHybridSearchQuery } from "./search.js";

interface AssertionRow extends QueryResultRow {
  tenant_id: string;
  assertion_id: string;
  subject_entity_id: string;
  predicate: string;
  object_json: TypedValue;
  kind: string;
  perspective: string;
  valid_from: Date;
  valid_to: Date | null;
  system_from: Date;
  system_to: Date | null;
  strength_json: Strength;
  authority: number;
  status: string;
  source_artifact_id: string | null;
  basis_json: JsonValue | null;
  supersedes_assertion_id: string | null;
  created_by: string;
}

interface EntityRow extends QueryResultRow {
  tenant_id: string;
  entity_id: string;
  entity_type: string;
  canonical_name: string;
  created_at: Date;
}

interface ArtifactRow extends QueryResultRow {
  tenant_id: string;
  artifact_id: string;
  content_hash: string;
  media_type: string;
  storage_key: string;
  encryption_key_id: string;
  source_identity: string;
  observed_at: Date;
  sensitivity: string;
  retention_policy: string;
  status: string;
  created_at: Date;
}

interface InventoryRow extends QueryResultRow {
  tenant_id: string;
  sku: string;
  location: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  version: string | number;
  updated_at: Date;
}

interface MachineRow extends QueryResultRow {
  tenant_id: string;
  instance_id: string;
  machine_type: string;
  state: string;
  data_json: OrderData;
  revision: string | number;
  created_at: Date;
  updated_at: Date;
}

interface EffectRow extends QueryResultRow {
  tenant_id: string;
  effect_id: string;
  instance_id: string;
  originating_revision: string | number;
  effect_name: string;
  effect_type: string;
  target_url: string;
  status_url: string;
  request_json: JsonValue;
  idempotency_key: string;
  status: string;
  attempt_count: number;
  outcome_json: JsonValue | null;
  created_at: Date;
  updated_at: Date;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  result_json: IntentExecutionResult;
}

interface PreparedAssertion {
  persistedSearchText: string;
  embedding: number[];
}

interface PreparedArtifact {
  stored: StoredArtifact;
  artifactId: string;
}

export class ProductionKernel {
  private readonly activeEmbeddingSpace: EmbeddingSpace;

  public constructor(
    private readonly database: ProductionDatabase,
    private readonly artifactStore: EncryptedArtifactStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly config: Pick<
      ProductionConfig,
      | "effectAllowedHosts"
      | "searchCandidateLimit"
      | "hnswEfSearch"
      | "hnswMaxScanTuples"
    >,
    private readonly metrics: MetricsRegistry,
    private readonly logger: Logger,
  ) {
    this.activeEmbeddingSpace = describeEmbeddingSpace(embeddings);
  }

  public embeddingSpace(): EmbeddingSpace {
    return { ...this.activeEmbeddingSpace };
  }

  public async execute(
    principal: AuthenticatedPrincipal,
    input: unknown,
  ): Promise<IntentExecutionResult> {
    const envelope = parseIntentEnvelope(input);
    verifyEnvelopePrincipal(principal, envelope.principal);
    if (envelope.operation.op === "record_payment_outcome") {
      throw new KernelError(
        "unauthorized",
        "Payment outcomes are accepted only from the effect worker",
      );
    }
    requireScope(principal, operationScope(envelope.operation.op));

    const requestHash = sha256(
      stableStringify({
        principal: envelope.principal,
        operation: envelope.operation,
      }),
    );
    const operationKey = envelope.idempotencyKey ?? envelope.requestId;
    const started = performance.now();
    const existing = await this.database.withTenantTransaction(
      principal,
      async (client) => {
        await this.lockIdempotency(
          client,
          principal,
          operationKey,
        );
        return this.getIdempotency(
          client,
          principal,
          operationKey,
          requestHash,
        );
      },
    );
    if (existing) {
      this.metrics.increment("agentic_intents_total", {
        operation: envelope.operation.op,
        status: "ok",
      });
      this.metrics.observe(
        "agentic_intent_duration_ms",
        performance.now() - started,
        { operation: envelope.operation.op },
      );
      return { ...existing, idempotentReplay: true };
    }
    const preparedArtifact =
      envelope.operation.op === "put_artifact"
        ? await this.prepareArtifact(principal, envelope.operation)
        : null;
    const preparedAssertion =
      envelope.operation.op === "assert"
        ? await this.prepareAssertion(principal, envelope.operation)
        : null;
    let searchEmbedding: number[] | null = null;
    if (envelope.operation.op === "search") {
      searchEmbedding = (await this.embeddings.embed([
        envelope.operation.text,
      ]))[0] ?? null;
      if (!searchEmbedding) {
        throw new Error("Embedding provider returned no search vector");
      }
      validateEmbeddingVector(
        searchEmbedding,
        this.activeEmbeddingSpace.dimensions,
      );
    }

    try {
      const execution = await this.database.withTenantWriteTransaction(
        principal,
        async (client) => {
          await this.lockIdempotency(
            client,
            principal,
            operationKey,
          );
          const replay = await this.getIdempotency(
            client,
            principal,
            operationKey,
            requestHash,
          );
          if (replay) {
            return { ...replay, idempotentReplay: true };
          }

          const rawResult = await this.executeOperation(
            client,
            principal,
            envelope.operation,
            preparedArtifact,
            preparedAssertion,
            searchEmbedding,
          );
          const result = jsonResult(rawResult);
          const evidenceManifest = operationEvidence(rawResult);
          const receipt = await this.recordReceipt(
            client,
            principal,
            envelope.requestId,
            envelope.operation.op,
            result,
            evidenceManifest,
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
          await client.query(
            `INSERT INTO agentic.idempotency_results (
               tenant_id, principal_id, operation_key, request_hash, result_json
             ) VALUES ($1, $2, $3, $4, $5)`,
            [
              principal.tenantId,
              principal.principalId,
              operationKey,
              requestHash,
              response,
            ],
          );
          return response;
        },
      );
      this.metrics.increment("agentic_intents_total", {
        operation: envelope.operation.op,
        status: "ok",
      });
      return execution;
    } catch (error) {
      this.metrics.increment("agentic_intents_total", {
        operation: envelope.operation.op,
        status: "error",
      });
      throw error;
    } finally {
      this.metrics.observe(
        "agentic_intent_duration_ms",
        performance.now() - started,
        { operation: envelope.operation.op },
      );
    }
  }

  public async searchReadOnly(
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "search" }>,
  ): Promise<SearchHit[]> {
    requireScope(principal, "data:read");
    const embedding = (await this.embeddings.embed([operation.text]))[0];
    if (!embedding) {
      throw new Error("Embedding provider returned no search vector");
    }
    validateEmbeddingVector(
      embedding,
      this.activeEmbeddingSpace.dimensions,
    );
    return this.database.withTenantTransaction(principal, (client) =>
      this.search(client, operation, embedding),
    );
  }

  public async resolveReadOnly(
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "resolve" }>,
  ): Promise<ResolutionResult> {
    requireScope(principal, "data:read");
    return this.database.withTenantTransaction(principal, (client) =>
      this.resolve(client, operation),
    );
  }

  public async getMachineReadOnly(
    principal: AuthenticatedPrincipal,
    instanceId: string,
  ): Promise<MachineRecord> {
    requireScope(principal, "data:read");
    return this.database.withTenantTransaction(principal, (client) =>
      this.getMachine(client, principal.tenantId, instanceId),
    );
  }

  private async prepareArtifact(
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "put_artifact" }>,
  ): Promise<PreparedArtifact> {
    const artifactId =
      operation.artifact.artifactId ??
      `artifact_${sha256(
        principal.tenantId,
        operation.artifact.sourceIdentity,
        sha256(operation.artifact.content),
      ).slice(0, 24)}`;
    const stored = await this.artifactStore.put(
      principal.tenantId,
      artifactId,
      operation.artifact.mediaType,
      operation.artifact.content,
    );
    return { stored, artifactId };
  }

  private async prepareAssertion(
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "assert" }>,
  ): Promise<PreparedAssertion> {
    const context = await this.database.withTenantTransaction(
      principal,
      async (client) => {
        const entityResult = await client.query<EntityRow>(
          `SELECT * FROM agentic.entities
           WHERE tenant_id = $1 AND entity_id = $2`,
          [principal.tenantId, operation.assertion.subjectEntityId],
        );
        const entity = entityResult.rows[0];
        if (!entity) {
          throw new KernelError("not_found", "Assertion subject was not found");
        }

        let sourceIdentity = "";
        let artifactContent = "";
        if (operation.assertion.sourceArtifactId) {
          const artifactResult = await client.query<ArtifactRow>(
            `SELECT * FROM agentic.artifacts
             WHERE tenant_id = $1 AND artifact_id = $2 AND status = 'active'`,
            [principal.tenantId, operation.assertion.sourceArtifactId],
          );
          const artifact = artifactResult.rows[0];
          if (!artifact) {
            throw new KernelError(
              "not_found",
              "Assertion source artifact was not found",
            );
          }
          sourceIdentity = artifact.source_identity;
          artifactContent = await this.artifactStore.get({
            tenantId: artifact.tenant_id,
            artifactId: artifact.artifact_id,
            mediaType: artifact.media_type,
            contentHash: artifact.content_hash,
            storageKey: artifact.storage_key,
            encryptionKeyId: artifact.encryption_key_id,
          });
        }
        return {
          entityName: entity.canonical_name,
          sourceIdentity,
          artifactContent,
        };
      },
    );

    const perspective = operation.assertion.perspective ?? "organization";
    const persistedSearchText = [
      context.entityName,
      operation.assertion.predicate.replaceAll("_", " "),
      typedValueText(operation.assertion.object),
      operation.assertion.kind.replaceAll("_", " "),
      perspective,
      context.sourceIdentity,
    ].join(" ");
    const embeddingText = `${persistedSearchText} ${context.artifactContent.slice(
      0,
      Math.max(0, 100_000 - persistedSearchText.length - 1),
    )}`;
    if (persistedSearchText.length > 100_000) {
      throw new KernelError(
        "invalid_input",
        "Assertion metadata exceeds the embedding input limit",
      );
    }
    const embedding = (await this.embeddings.embed([embeddingText]))[0];
    if (!embedding) {
      throw new Error("Embedding provider returned no assertion vector");
    }
    validateEmbeddingVector(
      embedding,
      this.activeEmbeddingSpace.dimensions,
    );
    return { persistedSearchText, embedding };
  }

  private async executeOperation(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: AgentOperation,
    preparedArtifact: PreparedArtifact | null,
    preparedAssertion: PreparedAssertion | null,
    searchEmbedding: number[] | null,
  ): Promise<unknown> {
    switch (operation.op) {
      case "put_entity":
        return this.putEntity(client, principal, operation);
      case "put_artifact":
        if (!preparedArtifact) {
          throw new Error("Artifact preparation was not completed");
        }
        return this.putArtifact(client, principal, operation, preparedArtifact);
      case "assert":
        if (!preparedAssertion) {
          throw new Error("Assertion preparation was not completed");
        }
        return this.putAssertion(
          client,
          principal,
          operation,
          preparedAssertion,
        );
      case "resolve":
        return this.resolve(client, operation);
      case "search":
        if (!searchEmbedding) {
          throw new Error("Search embedding was not prepared");
        }
        return this.search(client, operation, searchEmbedding);
      case "seed_inventory":
        return this.seedInventory(client, principal, operation);
      case "reserve_inventory":
        return this.reserveInventory(client, principal, operation);
      case "request_payment":
        return this.requestPayment(client, principal, operation);
      case "record_payment_outcome":
        return this.recordPaymentOutcome(client, principal, operation);
      case "get_machine":
        return this.getMachine(client, principal.tenantId, operation.instanceId);
      case "list_effects":
        return this.listEffects(client, principal.tenantId, operation.instanceId);
      case "process_timers":
        return this.processTimers(client, principal, operation.asOf);
    }
  }

  private async putEntity(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "put_entity" }>,
  ): Promise<JsonValue> {
    const result = await client.query<EntityRow>(
      `INSERT INTO agentic.entities (
         tenant_id, entity_id, entity_type, canonical_name
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, entity_id) DO UPDATE SET
         entity_type = EXCLUDED.entity_type,
         canonical_name = EXCLUDED.canonical_name
       RETURNING *`,
      [
        principal.tenantId,
        operation.entity.entityId,
        operation.entity.entityType,
        operation.entity.canonicalName,
      ],
    );
    const row = requiredRow(result.rows[0], "Entity was not persisted");
    return {
      tenantId: row.tenant_id,
      entityId: row.entity_id,
      entityType: row.entity_type,
      canonicalName: row.canonical_name,
      createdAt: row.created_at.toISOString(),
    };
  }

  private async putArtifact(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "put_artifact" }>,
    prepared: PreparedArtifact,
  ): Promise<JsonValue> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`artifact\u001f${principal.tenantId}\u001f${prepared.artifactId}`],
    );
    const existing = await client.query<ArtifactRow>(
      `SELECT * FROM agentic.artifacts
       WHERE tenant_id = $1 AND artifact_id = $2
       FOR UPDATE`,
      [principal.tenantId, prepared.artifactId],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (
        prior.content_hash !== prepared.stored.contentHash ||
        prior.media_type !== operation.artifact.mediaType ||
        prior.source_identity !== operation.artifact.sourceIdentity
      ) {
        throw new KernelError(
          "conflict",
          `Artifact ${prepared.artifactId} is immutable`,
        );
      }
      return artifactMetadata(prior);
    }

    const observedAt = normalizeIsoTimestamp(
      operation.artifact.observedAt ?? new Date().toISOString(),
      "observedAt",
    );
    const result = await client.query<ArtifactRow>(
      `INSERT INTO agentic.artifacts (
         tenant_id, artifact_id, content_hash, media_type, storage_key,
         encryption_key_id, source_identity, observed_at, sensitivity,
         retention_policy, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
       RETURNING *`,
      [
        principal.tenantId,
        prepared.artifactId,
        prepared.stored.contentHash,
        operation.artifact.mediaType,
        prepared.stored.storageKey,
        prepared.stored.encryptionKeyId,
        operation.artifact.sourceIdentity,
        observedAt,
        operation.artifact.sensitivity ?? "internal",
        operation.artifact.retentionPolicy ?? "project",
      ],
    );
    return artifactMetadata(
      requiredRow(result.rows[0], "Artifact metadata was not persisted"),
    );
  }

  private async putAssertion(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "assert" }>,
    prepared: PreparedAssertion,
  ): Promise<AssertionRecord> {
    const input = operation.assertion;
    const perspective = input.perspective ?? "organization";
    const validFrom = normalizeIsoTimestamp(
      input.validFrom ?? new Date().toISOString(),
      "validFrom",
    );
    const validTo = input.validTo
      ? normalizeIsoTimestamp(input.validTo, "validTo")
      : null;
    if (validTo && validTo <= validFrom) {
      throw new KernelError(
        "invalid_input",
        "validTo must be later than validFrom",
      );
    }
    const strength = input.strength ?? { type: "none" };
    const assertionId = input.assertionId ?? `assertion_${randomUUID()}`;

    if (input.object.type === "entity") {
      const objectEntity = await client.query(
        `SELECT 1 FROM agentic.entities
         WHERE tenant_id = $1 AND entity_id = $2`,
        [principal.tenantId, input.object.value],
      );
      if (objectEntity.rowCount !== 1) {
        throw new KernelError("not_found", "Assertion object entity was not found");
      }
    }
    if (input.sourceArtifactId) {
      const artifact = await client.query(
        `SELECT 1 FROM agentic.artifacts
         WHERE tenant_id = $1 AND artifact_id = $2 AND status = 'active'`,
        [principal.tenantId, input.sourceArtifactId],
      );
      if (artifact.rowCount !== 1) {
        throw new KernelError(
          "not_found",
          "Assertion source artifact was not found",
        );
      }
    }

    const timeResult = await client.query<{ system_time: Date }>(
      "SELECT agentic.next_system_time() AS system_time",
    );
    const systemTime = requiredRow(
      timeResult.rows[0],
      "System time allocation failed",
    ).system_time;

    if (input.supersedesAssertionId) {
      const priorResult = await client.query<AssertionRow>(
        `SELECT * FROM agentic.assertions
         WHERE tenant_id = $1 AND assertion_id = $2
         FOR UPDATE`,
        [principal.tenantId, input.supersedesAssertionId],
      );
      const prior = requiredRow(
        priorResult.rows[0],
        "Superseded assertion was not found",
      );
      if (prior.system_to !== null) {
        throw new KernelError("conflict", "Assertion is already closed");
      }
      if (
        prior.subject_entity_id !== input.subjectEntityId ||
        prior.predicate !== input.predicate ||
        prior.perspective !== perspective
      ) {
        throw new KernelError(
          "conflict",
          "A superseding assertion must keep subject, predicate, and perspective",
        );
      }
      await client.query(
        `UPDATE agentic.assertions
         SET system_to = $1
         WHERE tenant_id = $2 AND assertion_id = $3`,
        [systemTime, principal.tenantId, input.supersedesAssertionId],
      );
    }

    const result = await client.query<AssertionRow>(
      `INSERT INTO agentic.assertions (
         tenant_id, assertion_id, subject_entity_id, predicate,
         object_type, object_json, object_key, object_entity_id, kind,
         perspective, valid_from, valid_to, system_from, strength_type,
         strength_json, authority, status, source_artifact_id, basis_json,
         supersedes_assertion_id, search_text, embedding, embedding_model,
         embedding_version, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22::vector, $23, $24, $25
       )
       RETURNING *`,
      [
        principal.tenantId,
        assertionId,
        input.subjectEntityId,
        input.predicate,
        input.object.type,
        input.object,
        stableStringify(input.object),
        input.object.type === "entity" ? input.object.value : null,
        input.kind,
        perspective,
        validFrom,
        validTo,
        systemTime,
        strength.type,
        strength,
        input.authority ?? 50,
        input.status ?? "active",
        input.sourceArtifactId ?? null,
        input.basis ?? null,
        input.supersedesAssertionId ?? null,
        prepared.persistedSearchText,
        vectorToSql(prepared.embedding),
        this.activeEmbeddingSpace.model,
        this.activeEmbeddingSpace.version,
        principal.principalId,
      ],
    );
    return mapAssertion(
      requiredRow(result.rows[0], "Assertion was not persisted"),
    );
  }

  private async resolve(
    client: PoolClient,
    operation: Extract<AgentOperation, { op: "resolve" }>,
  ): Promise<ResolutionResult> {
    const current = await currentSystemTime(client);
    const systemAt = normalizeIsoTimestamp(
      operation.systemAt ?? current,
      "systemAt",
    );
    const validAt = normalizeIsoTimestamp(
      operation.validAt ?? systemAt,
      "validAt",
    );
    const values: unknown[] = [
      operation.subjectEntityId,
      operation.predicate,
      systemAt,
      validAt,
    ];
    const perspectiveClause = operation.perspective
      ? `AND perspective = $${values.push(operation.perspective)}`
      : "";
    const result = await client.query<AssertionRow>(
      `SELECT * FROM agentic.assertions
       WHERE subject_entity_id = $1
         AND predicate = $2
         AND system_from <= $3
         AND (system_to IS NULL OR system_to > $3)
         AND valid_from <= $4
         AND (valid_to IS NULL OR valid_to > $4)
         AND status NOT IN ('quarantined', 'deleted')
         ${perspectiveClause}
       ORDER BY authority DESC, system_from DESC`,
      values,
    );
    const candidates = result.rows.map(mapAssertion);
    return resolveCandidates(
      candidates,
      operation.policy,
      validAt,
      systemAt,
    );
  }

  private async search(
    client: PoolClient,
    operation: Extract<AgentOperation, { op: "search" }>,
    embedding: number[],
  ): Promise<SearchHit[]> {
    const current = await currentSystemTime(client);
    const systemAt = normalizeIsoTimestamp(
      operation.systemAt ?? current,
      "systemAt",
    );
    const validAt = normalizeIsoTimestamp(
      operation.validAt ?? systemAt,
      "validAt",
    );
    const resultLimit = operation.limit ?? 20;
    const candidateLimit = Math.max(
      this.config.searchCandidateLimit,
      Math.min(5_000, resultLimit * 4),
    );
    const efSearch = Math.max(
      this.config.hnswEfSearch,
      Math.min(1_000, candidateLimit),
    );
    await client.query(
      `SELECT
         set_config('hnsw.iterative_scan', 'strict_order', TRUE),
         set_config('hnsw.ef_search', $1, TRUE),
         set_config('hnsw.max_scan_tuples', $2, TRUE)`,
      [String(efSearch), String(this.config.hnswMaxScanTuples)],
    );
    const query = buildHybridSearchQuery({
      ...this.activeEmbeddingSpace,
      embedding,
      operation,
      systemAt,
      validAt,
      candidateLimit,
      resultLimit,
    });
    const result = await client.query<
      AssertionRow & {
        lexical_score: number;
        vector_score: number;
        combined_score: number;
        graph_distance: number | null;
      }
    >(query);
    return result.rows.map((row) => ({
      assertion: mapAssertion(row),
      lexicalScore: roundScore(row.lexical_score),
      vectorScore: roundScore(row.vector_score),
      combinedScore: roundScore(row.combined_score),
      graphDistance: row.graph_distance,
    }));
  }

  private async seedInventory(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "seed_inventory" }>,
  ): Promise<InventoryRecord> {
    const existing = await client.query<InventoryRow>(
      `SELECT * FROM agentic.inventory
       WHERE tenant_id = $1 AND sku = $2 AND location = $3
       FOR UPDATE`,
      [principal.tenantId, operation.sku, operation.location],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (
        prior.quantity_on_hand !== operation.quantityOnHand ||
        prior.quantity_reserved !== 0
      ) {
        throw new KernelError(
          "conflict",
          "Existing inventory cannot be reset through seed_inventory",
        );
      }
      return mapInventory(prior);
    }
    const time = await nextSystemTime(client);
    const result = await client.query<InventoryRow>(
      `INSERT INTO agentic.inventory (
         tenant_id, sku, location, quantity_on_hand, quantity_reserved,
         version, updated_at
       ) VALUES ($1, $2, $3, $4, 0, 1, $5)
       RETURNING *`,
      [
        principal.tenantId,
        operation.sku,
        operation.location,
        operation.quantityOnHand,
        time,
      ],
    );
    return mapInventory(
      requiredRow(result.rows[0], "Inventory was not persisted"),
    );
  }

  private async reserveInventory(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "reserve_inventory" }>,
  ): Promise<JsonValue> {
    const inventoryResult = await client.query<InventoryRow>(
      `SELECT * FROM agentic.inventory
       WHERE tenant_id = $1 AND sku = $2 AND location = $3
       FOR UPDATE`,
      [principal.tenantId, operation.sku, operation.location],
    );
    const inventory = requiredRow(
      inventoryResult.rows[0],
      "Inventory was not found",
    );
    const allocatable =
      inventory.quantity_on_hand - inventory.quantity_reserved;
    if (allocatable < operation.quantity) {
      throw new KernelError(
        "conflict",
        `Only ${allocatable} units are allocatable`,
      );
    }
    const instanceId = `order:${operation.orderId}`;
    const existing = await client.query(
      `SELECT 1 FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2`,
      [principal.tenantId, instanceId],
    );
    if (existing.rowCount !== 0) {
      throw new KernelError("conflict", `Order ${operation.orderId} exists`);
    }

    const time = await nextSystemTime(client);
    const expiresAt = new Date(
      time.getTime() + operation.holdSeconds * 1_000,
    );
    const data: OrderData = {
      orderId: operation.orderId,
      sku: operation.sku,
      location: operation.location,
      quantity: operation.quantity,
      reservationExpiresAt: expiresAt.toISOString(),
    };
    await client.query(
      `UPDATE agentic.inventory
       SET quantity_reserved = quantity_reserved + $1,
           version = version + 1,
           updated_at = $2
       WHERE tenant_id = $3 AND sku = $4 AND location = $5`,
      [
        operation.quantity,
        time,
        principal.tenantId,
        operation.sku,
        operation.location,
      ],
    );
    const machineResult = await client.query<MachineRow>(
      `INSERT INTO agentic.machine_instances (
         tenant_id, instance_id, machine_type, state, data_json, revision,
         created_at, updated_at
       ) VALUES ($1, $2, 'retail_order', 'reserved', $3, 1, $4, $4)
       RETURNING *`,
      [principal.tenantId, instanceId, data, time],
    );
    await this.appendHistory(
      client,
      principal.tenantId,
      instanceId,
      1,
      "reserve_inventory",
      "new",
      "reserved",
      data,
      time,
    );
    const timerId = deterministicId(
      "timer",
      principal.tenantId,
      instanceId,
      "1",
      "reservation_expiry",
    );
    await client.query(
      `INSERT INTO agentic.timers (
         tenant_id, timer_id, instance_id, originating_revision, timer_name,
         due_at, status, created_at, updated_at
       ) VALUES ($1, $2, $3, 1, 'reservation_expiry', $4, 'pending', $5, $5)`,
      [principal.tenantId, timerId, instanceId, expiresAt, time],
    );
    return {
      machine: toJsonValue(
        mapMachine(
          requiredRow(machineResult.rows[0], "Order machine was not persisted"),
        ),
      ),
      inventory: toJsonValue(
        await this.getInventory(
          client,
          principal.tenantId,
          operation.sku,
          operation.location,
        ),
      ),
      timerId,
    };
  }

  private async requestPayment(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "request_payment" }>,
  ): Promise<EffectRecord> {
    validateEffectTarget(operation.paymentTarget, this.config.effectAllowedHosts);
    if (!operation.paymentStatusUrl) {
      throw new KernelError(
        "invalid_input",
        "paymentStatusUrl is required in the production profile",
      );
    }
    validateEffectTarget(
      operation.paymentStatusUrl,
      this.config.effectAllowedHosts,
    );
    const machineResult = await client.query<MachineRow>(
      `SELECT * FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2
       FOR UPDATE`,
      [principal.tenantId, operation.instanceId],
    );
    const machine = mapMachine(
      requiredRow(machineResult.rows[0], "Order machine was not found"),
    );
    if (machine.state !== "reserved") {
      throw new KernelError(
        "conflict",
        `Payment can only start from reserved, not ${machine.state}`,
      );
    }
    const time = await nextSystemTime(client);
    if (time.toISOString() >= machine.data.reservationExpiresAt) {
      throw new KernelError("conflict", "The inventory reservation has expired");
    }
    const budget = await client.query(
      `UPDATE agentic_auth.api_keys
       SET effect_budget_reserved = effect_budget_reserved + $1
       WHERE key_id = $2
         AND tenant_id = $3
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > clock_timestamp())
         AND (
           '*' = ANY(purposes)
           OR $4 = ANY(purposes)
         )
         AND effect_budget_spent + effect_budget_reserved + $1
           <= effect_budget_limit
         AND effect_budget_currency = $5`,
      [
        operation.amount,
        principal.keyId,
        principal.tenantId,
        principal.purpose,
        operation.currency,
      ],
    );
    if (budget.rowCount !== 1) {
      throw new KernelError(
        "unauthorized",
        "Effect authorization expired, was revoked, or exceeded its budget",
      );
    }
    const nextRevision = machine.revision + 1;
    const effectName = "capture_payment";
    const effectId = deterministicId(
      "effect",
      principal.tenantId,
      machine.instanceId,
      String(nextRevision),
      effectName,
    );
    const request: JsonValue = {
      orderId: machine.data.orderId,
      amount: operation.amount,
      currency: operation.currency,
    };
    await client.query(
      `UPDATE agentic.machine_instances
       SET state = 'payment_pending', revision = $1, updated_at = $2
       WHERE tenant_id = $3 AND instance_id = $4`,
      [nextRevision, time, principal.tenantId, machine.instanceId],
    );
    await this.appendHistory(
      client,
      principal.tenantId,
      machine.instanceId,
      nextRevision,
      "request_payment",
      machine.state,
      "payment_pending",
      machine.data,
      time,
    );
    await client.query(
      `UPDATE agentic.timers
       SET status = 'cancelled', updated_at = $1
       WHERE tenant_id = $2 AND instance_id = $3 AND status = 'pending'`,
      [time, principal.tenantId, machine.instanceId],
    );
    const effectResult = await client.query<EffectRow>(
      `INSERT INTO agentic.effect_intents (
         tenant_id, effect_id, instance_id, originating_revision, effect_name,
         effect_type, target_url, request_json, idempotency_key,
         status_url,
         authorizing_key_id, purpose, budget_amount, currency, status,
         attempt_count, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'payment.capture', $6, $7, $8, $9,
         $10, $11, $12, $13, 'planned', 0, $14
       )
       RETURNING *`,
      [
        principal.tenantId,
        effectId,
        machine.instanceId,
        nextRevision,
        effectName,
        operation.paymentTarget,
        request,
        operation.idempotencyKey,
        operation.paymentStatusUrl,
        principal.keyId,
        principal.purpose,
        operation.amount,
        operation.currency,
        time,
      ],
    );
    return mapEffect(
      requiredRow(effectResult.rows[0], "Effect intent was not persisted"),
    );
  }

  private async recordPaymentOutcome(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operation: Extract<AgentOperation, { op: "record_payment_outcome" }>,
  ): Promise<MachineRecord> {
    const effectResult = await client.query<EffectRow & {
      budget_amount: string;
      authorizing_key_id: string;
    }>(
      `SELECT * FROM agentic.effect_intents
       WHERE tenant_id = $1 AND effect_id = $2
       FOR UPDATE`,
      [principal.tenantId, operation.effectId],
    );
    const effectRow = requiredRow(
      effectResult.rows[0],
      "Effect intent was not found",
    );
    if (
      operation.status === "succeeded" &&
      !hasProviderReference(operation.outcome)
    ) {
      throw new KernelError(
        "invalid_input",
        "Successful payment outcomes require a providerReference",
      );
    }
    if (effectRow.status === "succeeded" || effectRow.status === "failed") {
      if (effectRow.status !== operation.status) {
        throw new KernelError(
          "conflict",
          `Effect is already terminal as ${effectRow.status}`,
        );
      }
      return this.getMachine(client, principal.tenantId, effectRow.instance_id);
    }
    const machineResult = await client.query<MachineRow>(
      `SELECT * FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2
       FOR UPDATE`,
      [principal.tenantId, effectRow.instance_id],
    );
    const machine = mapMachine(
      requiredRow(machineResult.rows[0], "Order machine was not found"),
    );
    if (machine.state !== "payment_pending") {
      throw new KernelError(
        "conflict",
        `Payment outcome cannot apply to ${machine.state}`,
      );
    }
    const time = await nextSystemTime(client);
    const nextAttempt = effectRow.attempt_count + 1;
    await client.query(
      `INSERT INTO agentic.effect_attempts (
         tenant_id, effect_id, attempt_number, lease_token, status,
         outcome_json, created_at
       ) VALUES ($1, $2, $3, gen_random_uuid(), $4, $5, $6)`,
      [
        principal.tenantId,
        effectRow.effect_id,
        nextAttempt,
        operation.status,
        operation.outcome ?? null,
        time,
      ],
    );
    await client.query(
      `UPDATE agentic.effect_intents
       SET status = $1,
           attempt_count = $2,
           outcome_json = $3,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = $4
       WHERE tenant_id = $5 AND effect_id = $6`,
      [
        operation.status,
        nextAttempt,
        operation.outcome ?? null,
        time,
        principal.tenantId,
        effectRow.effect_id,
      ],
    );

    let nextState: MachineState = "payment_pending";
    if (operation.status === "succeeded") {
      await this.commitInventory(client, principal.tenantId, machine.data, time);
      await client.query(
        `UPDATE agentic_auth.api_keys
         SET effect_budget_reserved = effect_budget_reserved - $1,
             effect_budget_spent = effect_budget_spent + $1
         WHERE key_id = $2 AND tenant_id = $3`,
        [
          effectRow.budget_amount,
          effectRow.authorizing_key_id,
          principal.tenantId,
        ],
      );
      nextState = "confirmed";
    } else if (operation.status === "failed") {
      await this.releaseInventory(client, principal.tenantId, machine.data, time);
      await client.query(
        `UPDATE agentic_auth.api_keys
         SET effect_budget_reserved = effect_budget_reserved - $1
         WHERE key_id = $2 AND tenant_id = $3`,
        [
          effectRow.budget_amount,
          effectRow.authorizing_key_id,
          principal.tenantId,
        ],
      );
      nextState = "failed";
    }

    const nextRevision = machine.revision + 1;
    const updated = await client.query<MachineRow>(
      `UPDATE agentic.machine_instances
       SET state = $1, revision = $2, updated_at = $3
       WHERE tenant_id = $4 AND instance_id = $5
       RETURNING *`,
      [
        nextState,
        nextRevision,
        time,
        principal.tenantId,
        machine.instanceId,
      ],
    );
    await this.appendHistory(
      client,
      principal.tenantId,
      machine.instanceId,
      nextRevision,
      `payment_${operation.status}`,
      machine.state,
      nextState,
      machine.data,
      time,
    );
    return mapMachine(
      requiredRow(updated.rows[0], "Order machine was not updated"),
    );
  }

  private async processTimers(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    asOfInput: string | undefined,
  ): Promise<MachineRecord[]> {
    if (asOfInput !== undefined) {
      throw new KernelError(
        "invalid_input",
        "Production timer processing uses database server time",
      );
    }
    const asOf = await currentSystemTime(client);
    const timers = await client.query<{
      timer_id: string;
      instance_id: string;
      timer_name: string;
    }>(
      `SELECT timer_id, instance_id, timer_name
       FROM agentic.timers
       WHERE tenant_id = $1 AND status = 'pending' AND due_at <= $2
       ORDER BY due_at
       FOR UPDATE`,
      [principal.tenantId, asOf],
    );
    const changed: MachineRecord[] = [];
    for (const timer of timers.rows) {
      const machine = await this.getMachine(
        client,
        principal.tenantId,
        timer.instance_id,
        true,
      );
      const time = await nextSystemTime(client);
      if (machine.state !== "reserved") {
        await client.query(
          `UPDATE agentic.timers
           SET status = 'cancelled', updated_at = $1
           WHERE tenant_id = $2 AND timer_id = $3`,
          [time, principal.tenantId, timer.timer_id],
        );
        continue;
      }
      await this.releaseInventory(client, principal.tenantId, machine.data, time);
      const nextRevision = machine.revision + 1;
      const updated = await client.query<MachineRow>(
        `UPDATE agentic.machine_instances
         SET state = 'cancelled', revision = $1, updated_at = $2
         WHERE tenant_id = $3 AND instance_id = $4
         RETURNING *`,
        [nextRevision, time, principal.tenantId, machine.instanceId],
      );
      await client.query(
        `UPDATE agentic.timers
         SET status = 'fired', updated_at = $1
         WHERE tenant_id = $2 AND timer_id = $3`,
        [time, principal.tenantId, timer.timer_id],
      );
      await this.appendHistory(
        client,
        principal.tenantId,
        machine.instanceId,
        nextRevision,
        timer.timer_name,
        machine.state,
        "cancelled",
        machine.data,
        time,
      );
      changed.push(
        mapMachine(requiredRow(updated.rows[0], "Machine was not updated")),
      );
    }
    return changed;
  }

  private async getMachine(
    client: PoolClient,
    tenantId: string,
    instanceId: string,
    forUpdate = false,
  ): Promise<MachineRecord> {
    const result = await client.query<MachineRow>(
      `SELECT * FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2
       ${forUpdate ? "FOR UPDATE" : ""}`,
      [tenantId, instanceId],
    );
    return mapMachine(requiredRow(result.rows[0], "Machine was not found"));
  }

  private async getInventory(
    client: PoolClient,
    tenantId: string,
    sku: string,
    location: string,
  ): Promise<InventoryRecord> {
    const result = await client.query<InventoryRow>(
      `SELECT * FROM agentic.inventory
       WHERE tenant_id = $1 AND sku = $2 AND location = $3`,
      [tenantId, sku, location],
    );
    return mapInventory(requiredRow(result.rows[0], "Inventory was not found"));
  }

  private async listEffects(
    client: PoolClient,
    tenantId: string,
    instanceId: string | undefined,
  ): Promise<EffectRecord[]> {
    const result = instanceId
      ? await client.query<EffectRow>(
          `SELECT * FROM agentic.effect_intents
           WHERE tenant_id = $1 AND instance_id = $2
           ORDER BY created_at`,
          [tenantId, instanceId],
        )
      : await client.query<EffectRow>(
          `SELECT * FROM agentic.effect_intents
           WHERE tenant_id = $1
           ORDER BY created_at`,
          [tenantId],
        );
    return result.rows.map(mapEffect);
  }

  private async appendHistory(
    client: PoolClient,
    tenantId: string,
    instanceId: string,
    revision: number,
    transitionName: string,
    priorState: MachineState,
    nextState: MachineState,
    data: OrderData,
    time: Date,
  ): Promise<void> {
    const eventId = deterministicId(
      "event",
      tenantId,
      instanceId,
      String(revision),
      transitionName,
    );
    await client.query(
      `INSERT INTO agentic.machine_history (
         tenant_id, instance_id, revision, event_id, transition_name,
         prior_state, new_state, data_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        tenantId,
        instanceId,
        revision,
        eventId,
        transitionName,
        priorState,
        nextState,
        data,
        time,
      ],
    );
  }

  private async releaseInventory(
    client: PoolClient,
    tenantId: string,
    order: OrderData,
    time: Date,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE agentic.inventory
       SET quantity_reserved = quantity_reserved - $1,
           version = version + 1,
           updated_at = $2
       WHERE tenant_id = $3 AND sku = $4 AND location = $5
         AND quantity_reserved >= $1`,
      [order.quantity, time, tenantId, order.sku, order.location],
    );
    if (result.rowCount !== 1) {
      throw new KernelError(
        "conflict",
        "Reserved inventory was unavailable for release",
      );
    }
  }

  private async commitInventory(
    client: PoolClient,
    tenantId: string,
    order: OrderData,
    time: Date,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE agentic.inventory
       SET quantity_on_hand = quantity_on_hand - $1,
           quantity_reserved = quantity_reserved - $1,
           version = version + 1,
           updated_at = $2
       WHERE tenant_id = $3 AND sku = $4 AND location = $5
         AND quantity_on_hand >= $1
         AND quantity_reserved >= $1`,
      [order.quantity, time, tenantId, order.sku, order.location],
    );
    if (result.rowCount !== 1) {
      throw new KernelError(
        "conflict",
        "Reserved inventory was unavailable for commit",
      );
    }
  }

  private async recordReceipt(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    requestId: string,
    operation: string,
    result: JsonValue,
    evidenceManifest: JsonValue,
  ): Promise<IntentExecutionResult["receipt"]> {
    const resultHash = sha256(stableStringify(result));
    const receiptId = deterministicId(
      "receipt",
      principal.tenantId,
      principal.principalId,
      principal.purpose,
      requestId,
      operation,
      resultHash,
      stableStringify(evidenceManifest),
    );
    const time = await nextSystemTime(client);
    await client.query(
      `INSERT INTO agentic.execution_receipts (
         tenant_id, receipt_id, request_id, principal_id, purpose, operation,
         snapshot_time, evidence_manifest_json, result_hash, result_json,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $7)`,
      [
        principal.tenantId,
        receiptId,
        requestId,
        principal.principalId,
        principal.purpose,
        operation,
        time,
        evidenceManifest,
        resultHash,
        result,
      ],
    );
    return {
      tenantId: principal.tenantId,
      receiptId,
      requestId,
      principalId: principal.principalId,
      purpose: principal.purpose,
      operation,
      snapshotTime: time.toISOString(),
      evidenceManifest,
      resultHash,
      result,
      createdAt: time.toISOString(),
    };
  }

  private async getIdempotency(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operationKey: string,
    requestHash: string,
  ): Promise<IntentExecutionResult | null> {
    const result = await client.query<IdempotencyRow>(
      `SELECT request_hash, result_json
       FROM agentic.idempotency_results
       WHERE tenant_id = $1 AND principal_id = $2 AND operation_key = $3`,
      [principal.tenantId, principal.principalId, operationKey],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (row.request_hash !== requestHash) {
      throw new KernelError(
        "conflict",
        `Idempotency key ${operationKey} was used for a different request`,
      );
    }
    return row.result_json;
  }

  private async lockIdempotency(
    client: PoolClient,
    principal: AuthenticatedPrincipal,
    operationKey: string,
  ): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [
        [
          principal.tenantId,
          principal.principalId,
          operationKey,
        ].join("\u001f"),
      ],
    );
  }

}

function verifyEnvelopePrincipal(
  authenticated: AuthenticatedPrincipal,
  supplied: {
    tenantId: string;
    principalId: string;
    purpose: string;
  },
): void {
  if (
    supplied.tenantId !== authenticated.tenantId ||
    supplied.principalId !== authenticated.principalId ||
    supplied.purpose !== authenticated.purpose
  ) {
    throw new KernelError(
      "unauthorized",
      "Intent principal must match the authenticated principal",
    );
  }
}

function mapAssertion(row: AssertionRow): AssertionRecord {
  return {
    tenantId: row.tenant_id,
    assertionId: row.assertion_id,
    subjectEntityId: row.subject_entity_id,
    predicate: row.predicate,
    object: row.object_json,
    kind: row.kind as EpistemicKind,
    perspective: row.perspective,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null,
    systemFrom: row.system_from.toISOString(),
    systemTo: row.system_to?.toISOString() ?? null,
    strength: row.strength_json,
    authority: row.authority,
    status: row.status as AssertionRecord["status"],
    sourceArtifactId: row.source_artifact_id,
    basis: row.basis_json,
    supersedesAssertionId: row.supersedes_assertion_id,
    createdBy: row.created_by,
  };
}

function mapInventory(row: InventoryRow): InventoryRecord {
  return {
    tenantId: row.tenant_id,
    sku: row.sku,
    location: row.location,
    quantityOnHand: row.quantity_on_hand,
    quantityReserved: row.quantity_reserved,
    version: Number(row.version),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapMachine(row: MachineRow): MachineRecord {
  return {
    tenantId: row.tenant_id,
    instanceId: row.instance_id,
    machineType: "retail_order",
    state: row.state as MachineState,
    data: row.data_json,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapEffect(row: EffectRow): EffectRecord {
  return {
    tenantId: row.tenant_id,
    effectId: row.effect_id,
    instanceId: row.instance_id,
    originatingRevision: Number(row.originating_revision),
    effectName: row.effect_name,
    effectType: row.effect_type,
    target: row.target_url,
    request: row.request_json,
    idempotencyKey: row.idempotency_key,
    status: row.status as EffectRecord["status"],
    attemptCount: row.attempt_count,
    outcome: row.outcome_json,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function artifactMetadata(row: ArtifactRow): JsonValue {
  return {
    tenantId: row.tenant_id,
    artifactId: row.artifact_id,
    contentHash: row.content_hash,
    mediaType: row.media_type,
    sourceIdentity: row.source_identity,
    observedAt: row.observed_at.toISOString(),
    sensitivity: row.sensitivity,
    retentionPolicy: row.retention_policy,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function resolveCandidates(
  candidates: AssertionRecord[],
  policy: ResolutionPolicy,
  validAt: string,
  systemAt: string,
): ResolutionResult {
  if (candidates.length === 0) {
    return {
      status: "unknown",
      selected: null,
      candidates: [],
      conflicts: [],
      policy,
      validAt,
      systemAt,
    };
  }
  const values = new Set(
    candidates.map((candidate) => stableStringify(candidate.object)),
  );
  if (values.size === 1) {
    return {
      status: "known",
      selected: chooseLatest(candidates),
      candidates,
      conflicts: [],
      policy,
      validAt,
      systemAt,
    };
  }
  if (policy === "none") {
    return {
      status: "conflicted",
      selected: null,
      candidates,
      conflicts: candidates,
      policy,
      validAt,
      systemAt,
    };
  }
  const selected =
    policy === "latest"
      ? chooseLatest(candidates)
      : chooseHighestAuthority(candidates);
  return {
    status: "resolved_with_conflict",
    selected,
    candidates,
    conflicts: candidates.filter(
      (candidate) =>
        stableStringify(candidate.object) !== stableStringify(selected.object),
    ),
    policy,
    validAt,
    systemAt,
  };
}

function chooseLatest(assertions: AssertionRecord[]): AssertionRecord {
  return requiredRow(
    [...assertions].sort((left, right) =>
      right.systemFrom.localeCompare(left.systemFrom),
    )[0],
    "No assertion was available",
  );
}

function chooseHighestAuthority(
  assertions: AssertionRecord[],
): AssertionRecord {
  return requiredRow(
    [...assertions].sort(
      (left, right) =>
        right.authority - left.authority ||
        right.systemFrom.localeCompare(left.systemFrom),
    )[0],
    "No assertion was available",
  );
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new KernelError("not_found", message);
  }
  return row;
}

async function nextSystemTime(client: PoolClient): Promise<Date> {
  const result = await client.query<{ system_time: Date }>(
    "SELECT agentic.next_system_time() AS system_time",
  );
  return requiredRow(
    result.rows[0],
    "System time allocation failed",
  ).system_time;
}

async function currentSystemTime(client: PoolClient): Promise<string> {
  const result = await client.query<{ system_time: Date }>(
    `SELECT GREATEST(clock_timestamp(), last_time) AS system_time
     FROM agentic.system_clock
     WHERE singleton = TRUE`,
  );
  return requiredRow(
    result.rows[0],
    "System time was unavailable",
  ).system_time.toISOString();
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256(...parts).slice(0, 32)}`;
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function validateEffectTarget(urlValue: string, allowedHosts: Set<string>): void {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new KernelError("invalid_input", "Effect target must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new KernelError("unauthorized", "Effect targets must use HTTPS");
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new KernelError(
      "unauthorized",
      `Effect target host ${url.hostname} is not allowlisted`,
    );
  }
  if (url.username || url.password) {
    throw new KernelError(
      "invalid_input",
      "Effect target URLs cannot contain credentials",
    );
  }
}

function hasProviderReference(value: JsonValue | undefined): boolean {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    typeof value.providerReference === "string" &&
    value.providerReference.length > 0
  );
}
