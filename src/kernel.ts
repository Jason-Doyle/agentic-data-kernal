import { randomUUID } from "node:crypto";
import {
  normalizeTraceDepth,
  summarizeTraceJson,
  traceEndpointKey,
} from "./explain.js";
import type {
  AdvanceWorkflowInput,
  ArtifactInput,
  ArtifactRecord,
  AssertionInput,
  AssertionQuery,
  AssertionRecord,
  AssertionStatus,
  CatalogDescription,
  CreateWorkflowInput,
  EffectRecord,
  EffectOutcomeInput,
  EffectStatus,
  EntityInput,
  EntityRecord,
  EpistemicKind,
  ExecutionReceipt,
  GenericEffectRequestInput,
  InventoryRecord,
  JsonValue,
  LineageEdgeRecord,
  LineageEndpoint,
  LineageRelation,
  MachineRecord,
  MachineState,
  OrderData,
  PaymentOutcomeInput,
  PaymentRequestInput,
  PrincipalContext,
  ReservationResult,
  ReserveInventoryInput,
  ResolutionPolicy,
  ResolutionResult,
  SearchHit,
  SearchQuery,
  Strength,
  TraceExplanation,
  TraceNode,
  TypedValue,
  WorkflowRecord,
} from "./types.js";
import type { SqlRow, SqlValue } from "./store.js";
import { SqliteStore } from "./store.js";
import {
  cosineSimilarity,
  hashEmbedding,
  lexicalScore,
  normalizeIsoTimestamp,
  parseJson,
  sha256,
  stableStringify,
  tokenize,
  toJsonValue,
  typedValueText,
} from "./util.js";

interface AssertionDbRow extends SqlRow {
  tenant_id: string;
  assertion_id: string;
  subject_entity_id: string;
  predicate: string;
  object_type: string;
  object_json: string;
  object_key: string;
  object_entity_id: string | null;
  kind: string;
  perspective: string;
  valid_from: string;
  valid_to: string | null;
  system_from: string;
  system_to: string | null;
  strength_type: string;
  strength_json: string;
  authority: number;
  status: string;
  source_artifact_id: string | null;
  basis_json: string | null;
  supersedes_assertion_id: string | null;
  search_text: string;
  embedding_json: string;
  created_by: string;
}

interface ArtifactDbRow extends SqlRow {
  tenant_id: string;
  artifact_id: string;
  content_hash: string;
  media_type: string;
  content: string;
  source_identity: string;
  observed_at: string;
  sensitivity: string;
  retention_policy: string;
  status: string;
  created_at: string;
}

interface InventoryDbRow extends SqlRow {
  tenant_id: string;
  sku: string;
  location: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  version: number;
  updated_at: string;
}

interface MachineDbRow extends SqlRow {
  tenant_id: string;
  instance_id: string;
  machine_type: string;
  state: string;
  data_json: string;
  revision: number;
  terminal: number;
  created_at: string;
  updated_at: string;
}

interface EffectDbRow extends SqlRow {
  tenant_id: string;
  effect_id: string;
  instance_id: string;
  originating_revision: number;
  effect_name: string;
  effect_type: string;
  outcome_handler: string;
  target: string;
  status_url: string | null;
  request_json: string;
  idempotency_key: string;
  decision_assertion_id: string | null;
  policy_assertion_id: string | null;
  status: string;
  attempt_count: number;
  outcome_json: string | null;
  created_at: string;
  updated_at: string;
}

interface LineageDbRow extends SqlRow {
  tenant_id: string;
  edge_id: string;
  relation: string;
  from_artifact_id: string | null;
  from_assertion_id: string | null;
  from_instance_id: string | null;
  from_revision: number | null;
  from_effect_id: string | null;
  to_artifact_id: string | null;
  to_assertion_id: string | null;
  to_instance_id: string | null;
  to_revision: number | null;
  to_effect_id: string | null;
  created_by: string;
  created_at: string;
}

interface HistoryDbRow extends SqlRow {
  tenant_id: string;
  instance_id: string;
  revision: number;
  event_id: string;
  transition_name: string;
  prior_state: string;
  new_state: string;
  data_json: string;
  created_at: string;
  machine_type: string;
}

interface EffectAttemptDbRow extends SqlRow {
  attempt_number: number;
  status: string;
  outcome_json: string | null;
  created_at: string;
}

interface TimerDbRow extends SqlRow {
  tenant_id: string;
  timer_id: string;
  instance_id: string;
  originating_revision: number;
  timer_name: string;
  due_at: string;
  status: string;
}

interface IdempotencyDbRow extends SqlRow {
  request_hash: string;
  result_json: string;
}

interface ReceiptDbRow extends SqlRow {
  tenant_id: string;
  receipt_id: string;
  request_id: string;
  principal_id: string;
  purpose: string;
  operation: string;
  snapshot_time: string;
  evidence_manifest_json: string;
  result_hash: string;
  result_json: string;
  created_at: string;
}

export class KernelError extends Error {
  public constructor(
    public readonly code:
      | "invalid_input"
      | "not_found"
      | "conflict"
      | "unauthorized"
      | "unsafe_query",
    message: string,
  ) {
    super(message);
    this.name = "KernelError";
  }
}

export class AgenticKernel {
  public constructor(
    private readonly store: SqliteStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public transaction<T>(operation: () => T): T {
    return this.store.transaction(operation);
  }

  public putEntity(
    principal: PrincipalContext,
    input: EntityInput,
  ): EntityRecord {
    requireNonEmpty(input.entityId, "entityId");
    requireNonEmpty(input.entityType, "entityType");
    requireNonEmpty(input.canonicalName, "canonicalName");
    const createdAt = this.writeTime();
    this.store.run(
      `INSERT INTO entities (
         tenant_id, entity_id, entity_type, canonical_name, created_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, entity_id) DO UPDATE SET
         entity_type = excluded.entity_type,
         canonical_name = excluded.canonical_name`,
      principal.tenantId,
      input.entityId,
      input.entityType,
      input.canonicalName,
      createdAt,
    );
    const row = this.store.get<SqlRow>(
      `SELECT tenant_id, entity_id, entity_type, canonical_name, created_at
       FROM entities WHERE tenant_id = ? AND entity_id = ?`,
      principal.tenantId,
      input.entityId,
    );
    if (!row) {
      throw new KernelError("not_found", "Entity was not persisted");
    }
    return {
      tenantId: requireRowString(row, "tenant_id"),
      entityId: requireRowString(row, "entity_id"),
      entityType: requireRowString(row, "entity_type"),
      canonicalName: requireRowString(row, "canonical_name"),
      createdAt: requireRowString(row, "created_at"),
    };
  }

  public putArtifact(
    principal: PrincipalContext,
    input: ArtifactInput,
  ): ArtifactRecord {
    requireNonEmpty(input.mediaType, "mediaType");
    requireNonEmpty(input.content, "content");
    requireNonEmpty(input.sourceIdentity, "sourceIdentity");
    const createdAt = this.writeTime();
    const observedAt = normalizeIsoTimestamp(
      input.observedAt ?? createdAt,
      "observedAt",
    );
    const contentHash = sha256(input.content);
    const artifactId =
      input.artifactId ??
      `artifact_${sha256(
        principal.tenantId,
        input.sourceIdentity,
        contentHash,
      ).slice(0, 24)}`;
    const existing = this.store.get<ArtifactDbRow>(
      `SELECT * FROM artifacts
       WHERE tenant_id = ? AND artifact_id = ?`,
      principal.tenantId,
      artifactId,
    );
    if (existing) {
      if (
        existing.content_hash !== contentHash ||
        existing.media_type !== input.mediaType ||
        existing.source_identity !== input.sourceIdentity
      ) {
        throw new KernelError(
          "conflict",
          `Artifact ${artifactId} is immutable and already has different content or identity`,
        );
      }
      return this.getArtifact(principal.tenantId, artifactId);
    }
    this.store.run(
      `INSERT INTO artifacts (
         tenant_id, artifact_id, content_hash, media_type, content,
         source_identity, observed_at, sensitivity, retention_policy,
         status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      principal.tenantId,
      artifactId,
      contentHash,
      input.mediaType,
      input.content,
      input.sourceIdentity,
      observedAt,
      input.sensitivity ?? "internal",
      input.retentionPolicy ?? "project",
      createdAt,
    );
    return this.getArtifact(principal.tenantId, artifactId);
  }

  public getArtifact(tenantId: string, artifactId: string): ArtifactRecord {
    const row = this.store.get<ArtifactDbRow>(
      `SELECT * FROM artifacts
       WHERE tenant_id = ? AND artifact_id = ?`,
      tenantId,
      artifactId,
    );
    if (!row) {
      throw new KernelError("not_found", `Artifact ${artifactId} was not found`);
    }
    return {
      tenantId: row.tenant_id,
      artifactId: row.artifact_id,
      contentHash: row.content_hash,
      mediaType: row.media_type,
      content: row.content,
      sourceIdentity: row.source_identity,
      observedAt: row.observed_at,
      sensitivity: row.sensitivity,
      retentionPolicy: row.retention_policy,
      status: row.status === "deleted" ? "deleted" : "active",
      createdAt: row.created_at,
    };
  }

  public assert(
    principal: PrincipalContext,
    input: AssertionInput,
  ): AssertionRecord {
    return this.store.transaction(() => {
      requireNonEmpty(input.subjectEntityId, "subjectEntityId");
      requireNonEmpty(input.predicate, "predicate");
      this.requireEntity(principal.tenantId, input.subjectEntityId);
      if (input.object.type === "entity") {
        this.requireEntity(principal.tenantId, input.object.value);
      }
      let sourceArtifact: ArtifactRecord | null = null;
      if (input.sourceArtifactId) {
        sourceArtifact = this.getArtifact(
          principal.tenantId,
          input.sourceArtifactId,
        );
        if (sourceArtifact.status !== "active") {
          throw new KernelError(
            "conflict",
            "Deleted artifacts cannot support new assertions",
          );
        }
      }

      const systemFrom = this.writeTime();
      const validFrom = normalizeIsoTimestamp(
        input.validFrom ?? systemFrom,
        "validFrom",
      );
      const validTo = input.validTo
        ? normalizeIsoTimestamp(input.validTo, "validTo")
        : null;
      const perspective = input.perspective ?? "organization";
      if (validTo) {
        if (validTo <= validFrom) {
          throw new KernelError(
            "invalid_input",
            "validTo must be later than validFrom",
          );
        }
      }

      if (input.supersedesAssertionId) {
        const prior = this.getAssertion(
          principal.tenantId,
          input.supersedesAssertionId,
        );
        if (prior.systemTo !== null) {
          throw new KernelError(
            "conflict",
            `Assertion ${prior.assertionId} is already closed`,
          );
        }
        if (
          prior.subjectEntityId !== input.subjectEntityId ||
          prior.predicate !== input.predicate ||
          prior.perspective !== perspective
        ) {
          throw new KernelError(
            "conflict",
            "A superseding assertion must keep subject, predicate, and perspective",
          );
        }
        this.store.run(
          `UPDATE assertions
           SET system_to = ?
           WHERE tenant_id = ? AND assertion_id = ?`,
          systemFrom,
          principal.tenantId,
          prior.assertionId,
        );
      }

      const assertionId = input.assertionId ?? `assertion_${randomUUID()}`;
      const existingAssertion = this.store.get<AssertionDbRow>(
        `SELECT * FROM assertions
         WHERE tenant_id = ? AND assertion_id = ?`,
        principal.tenantId,
        assertionId,
      );
      if (existingAssertion) {
        throw new KernelError(
          "conflict",
          `Assertion ${assertionId} already exists`,
        );
      }
      const strength = input.strength ?? { type: "none" };
      validateStrength(strength);
      const objectJson = stableStringify(input.object);
      const subject = this.getEntity(
        principal.tenantId,
        input.subjectEntityId,
      );
      const searchText = [
        subject.canonicalName,
        input.predicate.replaceAll("_", " "),
        typedValueText(input.object),
        input.kind.replaceAll("_", " "),
        perspective,
        sourceArtifact?.sourceIdentity ?? "",
        sourceArtifact?.content.slice(0, 4_096) ?? "",
      ].join(" ");
      const embedding = hashEmbedding(searchText);

      this.store.run(
        `INSERT INTO assertions (
           tenant_id, assertion_id, subject_entity_id, predicate,
           object_type, object_json, object_key, object_entity_id,
           kind, perspective, valid_from, valid_to, system_from, system_to,
           strength_type, strength_json, authority, status,
           source_artifact_id, basis_json, supersedes_assertion_id,
           search_text, embedding_json, created_by
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
        principal.tenantId,
        assertionId,
        input.subjectEntityId,
        input.predicate,
        input.object.type,
        objectJson,
        objectJson,
        input.object.type === "entity" ? input.object.value : null,
        input.kind,
        perspective,
        validFrom,
        validTo,
        systemFrom,
        strength.type,
        stableStringify(strength),
        input.authority ?? 50,
        input.status ?? "active",
        input.sourceArtifactId ?? null,
        input.basis === undefined ? null : stableStringify(input.basis),
        input.supersedesAssertionId ?? null,
        searchText,
        stableStringify(embedding),
        principal.principalId,
      );
      this.store.run(
        `INSERT INTO assertion_fts (tenant_id, assertion_id, search_text)
         VALUES (?, ?, ?)`,
        principal.tenantId,
        assertionId,
        searchText,
      );
      if (input.sourceArtifactId) {
        this.insertLineage(principal, {
          relation: "evidence_for",
          from: {
            type: "artifact",
            artifactId: input.sourceArtifactId,
          },
          to: { type: "assertion", assertionId },
        });
      }
      return this.getAssertion(principal.tenantId, assertionId);
    });
  }

  public getEntity(tenantId: string, entityId: string): EntityRecord {
    const row = this.store.get<SqlRow>(
      `SELECT tenant_id, entity_id, entity_type, canonical_name, created_at
       FROM entities WHERE tenant_id = ? AND entity_id = ?`,
      tenantId,
      entityId,
    );
    if (!row) {
      throw new KernelError("not_found", `Entity ${entityId} was not found`);
    }
    return {
      tenantId: requireRowString(row, "tenant_id"),
      entityId: requireRowString(row, "entity_id"),
      entityType: requireRowString(row, "entity_type"),
      canonicalName: requireRowString(row, "canonical_name"),
      createdAt: requireRowString(row, "created_at"),
    };
  }

  public getAssertion(tenantId: string, assertionId: string): AssertionRecord {
    const row = this.store.get<AssertionDbRow>(
      `SELECT * FROM assertions
       WHERE tenant_id = ? AND assertion_id = ?`,
      tenantId,
      assertionId,
    );
    if (!row) {
      throw new KernelError(
        "not_found",
        `Assertion ${assertionId} was not found`,
      );
    }
    return mapAssertion(row);
  }

  public queryAssertions(
    tenantId: string,
    query: AssertionQuery = {},
  ): AssertionRecord[] {
    const systemAt = normalizeIsoTimestamp(
      query.systemAt ?? this.readTime(),
      "systemAt",
    );
    const validAt = normalizeIsoTimestamp(
      query.validAt ?? systemAt,
      "validAt",
    );
    const conditions = [
      "tenant_id = ?",
      "system_from <= ?",
      "(system_to IS NULL OR system_to > ?)",
      "valid_from <= ?",
      "(valid_to IS NULL OR valid_to > ?)",
      "status NOT IN ('quarantined', 'deleted')",
    ];
    const params: SqlValue[] = [
      tenantId,
      systemAt,
      systemAt,
      validAt,
      validAt,
    ];

    if (query.subjectEntityId) {
      conditions.push("subject_entity_id = ?");
      params.push(query.subjectEntityId);
    }
    if (query.predicate) {
      conditions.push("predicate = ?");
      params.push(query.predicate);
    }
    if (query.kind) {
      conditions.push("kind = ?");
      params.push(query.kind);
    }
    if (query.perspective) {
      conditions.push("perspective = ?");
      params.push(query.perspective);
    }
    params.push(clamp(query.limit ?? 100, 1, 1000));

    return this.store
      .all<AssertionDbRow>(
        `SELECT * FROM assertions
         WHERE ${conditions.join(" AND ")}
         ORDER BY authority DESC, system_from DESC
         LIMIT ?`,
        ...params,
      )
      .map(mapAssertion);
  }

  public resolve(
    tenantId: string,
    subjectEntityId: string,
    predicate: string,
    policy: ResolutionPolicy = "none",
    options: Pick<AssertionQuery, "perspective" | "validAt" | "systemAt"> = {},
  ): ResolutionResult {
    const systemAt = normalizeIsoTimestamp(
      options.systemAt ?? this.readTime(),
      "systemAt",
    );
    const validAt = normalizeIsoTimestamp(
      options.validAt ?? systemAt,
      "validAt",
    );
    const candidates = this.queryApplicableAssertions(
      tenantId,
      subjectEntityId,
      predicate,
      options.perspective,
      validAt,
      systemAt,
    );
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

    const groups = groupAssertions(candidates);
    if (groups.size === 1) {
      const selected = chooseLatest(candidates);
      return {
        status: "known",
        selected,
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

  public search(tenantId: string, query: SearchQuery): SearchHit[] {
    requireNonEmpty(query.text, "text");
    const systemAt = normalizeIsoTimestamp(
      query.systemAt ?? this.readTime(),
      "systemAt",
    );
    const validAt = normalizeIsoTimestamp(
      query.validAt ?? systemAt,
      "validAt",
    );
    const assertions = this.queryAssertions(tenantId, {
      predicate: query.predicate,
      kind: query.kind,
      perspective: query.perspective,
      validAt,
      systemAt,
      limit: 1000,
    });
    const ftsMatches = this.ftsMatches(tenantId, query.text);
    const graphDistances = query.relatedToEntityId
      ? this.graphDistances(
          tenantId,
          query.relatedToEntityId,
          query.maxGraphDepth ?? 2,
          validAt,
          systemAt,
        )
      : null;
    const queryEmbedding = hashEmbedding(query.text);

    return assertions
      .map((assertion): SearchHit | null => {
        const graphDistance = graphDistances
          ? minimumGraphDistance(assertion, graphDistances)
          : null;
        if (graphDistances && graphDistance === null) {
          return null;
        }
        const candidateText = this.assertionSearchText(assertion);
        const lexical = Math.max(
          lexicalScore(query.text, candidateText),
          ftsMatches.has(assertion.assertionId) ? 0.25 : 0,
        );
        const vector = Math.max(
          0,
          cosineSimilarity(queryEmbedding, hashEmbedding(candidateText)),
        );
        const graphBoost =
          graphDistance === null ? 0 : 0.1 / (1 + graphDistance);
        return {
          assertion,
          lexicalScore: roundScore(lexical),
          vectorScore: roundScore(vector),
          combinedScore: roundScore(0.45 * lexical + 0.55 * vector + graphBoost),
          graphDistance,
        };
      })
      .filter((hit): hit is SearchHit => hit !== null)
      .filter((hit) => hit.combinedScore > 0)
      .sort((left, right) => right.combinedScore - left.combinedScore)
      .slice(0, clamp(query.limit ?? 20, 1, 100));
  }

  public createWorkflow(
    principal: PrincipalContext,
    input: CreateWorkflowInput,
  ): WorkflowRecord {
    if (input.workflowType === "retail_order") {
      throw new KernelError(
        "invalid_input",
        "retail_order is reserved for the retail workflow",
      );
    }
    if (input.instanceId.startsWith("order:")) {
      throw new KernelError(
        "invalid_input",
        "The order: identifier namespace is reserved for retail workflows",
      );
    }
    return this.store.transaction(() => {
      const existing = this.store.get<MachineDbRow>(
        `SELECT * FROM machine_instances
         WHERE tenant_id = ? AND instance_id = ?`,
        principal.tenantId,
        input.instanceId,
      );
      if (existing) {
        throw new KernelError(
          "conflict",
          `Workflow ${input.instanceId} already exists`,
        );
      }
      const createdAt = this.writeTime();
      this.store.run(
        `INSERT INTO machine_instances (
           tenant_id, instance_id, machine_type, state, data_json, revision,
           terminal, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        principal.tenantId,
        input.instanceId,
        input.workflowType,
        input.initialState,
        stableStringify(input.data),
        createdAt,
        createdAt,
      );
      this.appendHistory(
        principal.tenantId,
        input.instanceId,
        1,
        "create_workflow",
        "uninitialized",
        input.initialState,
        input.data,
        createdAt,
      );
      return this.getWorkflow(principal.tenantId, input.instanceId);
    });
  }

  public advanceWorkflow(
    principal: PrincipalContext,
    input: AdvanceWorkflowInput,
  ): WorkflowRecord {
    return this.store.transaction(() => {
      const workflow = this.getWorkflow(
        principal.tenantId,
        input.instanceId,
      );
      if (workflow.terminal) {
        throw new KernelError(
          "conflict",
          `Workflow ${input.instanceId} is terminal`,
        );
      }
      if (
        workflow.revision !== input.expectedRevision ||
        workflow.state !== input.expectedState
      ) {
        throw new KernelError(
          "conflict",
          `Workflow ${input.instanceId} changed before ${input.transitionName}`,
        );
      }
      const nextRevision = workflow.revision + 1;
      const updatedAt = this.writeTime();
      const changes = this.store.run(
        `UPDATE machine_instances
         SET state = ?, data_json = ?, revision = ?, terminal = ?,
             updated_at = ?
         WHERE tenant_id = ? AND instance_id = ? AND revision = ?
           AND state = ? AND terminal = 0 AND machine_type <> 'retail_order'`,
        input.toState,
        stableStringify(input.data),
        nextRevision,
        input.terminal ? 1 : 0,
        updatedAt,
        principal.tenantId,
        input.instanceId,
        input.expectedRevision,
        input.expectedState,
      );
      if (changes !== 1) {
        throw new KernelError(
          "conflict",
          `Workflow ${input.instanceId} transition was not committed`,
        );
      }
      this.appendHistory(
        principal.tenantId,
        input.instanceId,
        nextRevision,
        input.transitionName,
        workflow.state,
        input.toState,
        input.data,
        updatedAt,
      );
      return this.getWorkflow(principal.tenantId, input.instanceId);
    });
  }

  public requestEffect(
    principal: PrincipalContext,
    input: GenericEffectRequestInput,
  ): EffectRecord {
    return this.store.transaction(() => {
      const operationKey = `effect:${input.idempotencyKey}`;
      const requestHash = sha256(stableStringify(input));
      const replay = this.getIdempotency<EffectRecord>(
        principal.tenantId,
        operationKey,
        requestHash,
      );
      if (replay) {
        return replay;
      }
      const workflow = this.getWorkflow(
        principal.tenantId,
        input.instanceId,
      );
      if (workflow.terminal) {
        throw new KernelError(
          "conflict",
          `Workflow ${input.instanceId} is terminal`,
        );
      }
      if (workflow.revision !== input.expectedRevision) {
        throw new KernelError(
          "conflict",
          `Workflow ${input.instanceId} revision changed`,
        );
      }
      this.requireCurrentAssertionKind(
        principal.tenantId,
        input.decisionAssertionId,
        "decision",
      );
      this.requireCurrentAssertionKind(
        principal.tenantId,
        input.policyAssertionId,
        "directive",
      );
      const effectId = deterministicId(
        "effect",
        principal.tenantId,
        workflow.instanceId,
        String(workflow.revision),
        input.effectName,
      );
      const createdAt = this.writeTime();
      this.store.run(
        `INSERT INTO effect_intents (
           tenant_id, effect_id, instance_id, originating_revision,
           effect_name, effect_type, outcome_handler, target, status_url,
           request_json, idempotency_key, decision_assertion_id,
           policy_assertion_id, status, attempt_count, outcome_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?,
           'planned', 0, NULL, ?, ?)`,
        principal.tenantId,
        effectId,
        workflow.instanceId,
        workflow.revision,
        input.effectName,
        input.effectType,
        input.target,
        input.statusUrl ?? null,
        stableStringify(input.request),
        input.idempotencyKey,
        input.decisionAssertionId,
        input.policyAssertionId,
        createdAt,
        createdAt,
      );
      const effectEndpoint: LineageEndpoint = {
        type: "effect",
        effectId,
      };
      this.insertLineage(principal, {
        relation: "authorizes",
        from: {
          type: "assertion",
          assertionId: input.decisionAssertionId,
        },
        to: effectEndpoint,
      });
      this.insertLineage(principal, {
        relation: "governs",
        from: {
          type: "assertion",
          assertionId: input.policyAssertionId,
        },
        to: effectEndpoint,
      });
      this.insertLineage(principal, {
        relation: "produces",
        from: {
          type: "workflow_revision",
          instanceId: workflow.instanceId,
          revision: workflow.revision,
        },
        to: effectEndpoint,
      });
      const effect = this.getEffect(principal.tenantId, effectId);
      this.putIdempotency(
        principal.tenantId,
        operationKey,
        requestHash,
        effect,
      );
      return effect;
    });
  }

  public recordEffectOutcome(
    principal: PrincipalContext,
    input: EffectOutcomeInput,
  ): EffectRecord {
    return this.store.transaction(() => {
      const operationKey =
        `generic-effect-outcome:${input.effectId}:${input.idempotencyKey}`;
      const requestHash = sha256(stableStringify(input));
      const replay = this.getIdempotency<EffectRecord>(
        principal.tenantId,
        operationKey,
        requestHash,
      );
      if (replay) {
        return replay;
      }
      const effect = this.getEffect(principal.tenantId, input.effectId);
      if (effect.outcomeHandler !== "none") {
        throw new KernelError(
          "conflict",
          "Generic outcomes cannot finalize retail payment effects",
        );
      }
      if (effect.status === "succeeded" || effect.status === "failed") {
        if (effect.status !== input.status) {
          throw new KernelError(
            "conflict",
            `Effect is already terminal as ${effect.status}`,
          );
        }
        this.putIdempotency(
          principal.tenantId,
          operationKey,
          requestHash,
          effect,
        );
        return effect;
      }
      const updatedAt = this.writeTime();
      const attemptNumber = effect.attemptCount + 1;
      const outcome = input.outcome ?? null;
      this.store.run(
        `INSERT INTO effect_attempts (
           tenant_id, effect_id, attempt_number, status, outcome_json,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        principal.tenantId,
        effect.effectId,
        attemptNumber,
        input.status,
        outcome === null ? null : stableStringify(outcome),
        updatedAt,
      );
      this.store.run(
        `UPDATE effect_intents
         SET status = ?, attempt_count = ?, outcome_json = ?, updated_at = ?
         WHERE tenant_id = ? AND effect_id = ?`,
        input.status,
        attemptNumber,
        outcome === null ? null : stableStringify(outcome),
        updatedAt,
        principal.tenantId,
        effect.effectId,
      );
      const updated = this.getEffect(principal.tenantId, effect.effectId);
      this.putIdempotency(
        principal.tenantId,
        operationKey,
        requestHash,
        updated,
      );
      return updated;
    });
  }

  public addLineage(
    principal: PrincipalContext,
    input: {
      relation: LineageRelation;
      from: LineageEndpoint;
      to: LineageEndpoint;
    },
  ): LineageEdgeRecord {
    return this.store.transaction(() =>
      this.insertLineage(principal, input),
    );
  }

  public explain(
    tenantId: string,
    root: LineageEndpoint,
    requestedDepth = 4,
  ): TraceExplanation {
    const maxDepth = normalizeTraceDepth(requestedDepth);
    const queue: Array<{ ref: LineageEndpoint; depth: number }> = [
      { ref: root, depth: 0 },
    ];
    const queued = new Set([traceEndpointKey(root)]);
    const includedEdges = new Map<string, LineageEdgeRecord>();
    const nodes: TraceNode[] = [];
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      const loaded = this.loadTraceNode(
        tenantId,
        current.ref,
        current.depth,
      );
      nodes.push(loaded.node);
      if (loaded.truncated) {
        truncated = true;
      }
      if (current.depth >= maxDepth) {
        continue;
      }
      if (includedEdges.size >= 2_000) {
        truncated = true;
        continue;
      }
      const edgeResult = this.lineageForEndpoint(tenantId, current.ref);
      if (edgeResult.truncated) {
        truncated = true;
      }
      for (const edge of edgeResult.edges) {
        if (includedEdges.has(edge.edgeId)) {
          continue;
        }
        if (includedEdges.size >= 2_000) {
          truncated = true;
          break;
        }
        const newNeighbors = [edge.from, edge.to].filter(
          (neighbor) => !queued.has(traceEndpointKey(neighbor)),
        );
        if (queued.size + newNeighbors.length > 500) {
          truncated = true;
          continue;
        }
        includedEdges.set(edge.edgeId, edge);
        for (const neighbor of newNeighbors) {
          const key = traceEndpointKey(neighbor);
          queued.add(key);
          queue.push({ ref: neighbor, depth: current.depth + 1 });
        }
      }
    }

    return {
      root,
      maxDepth,
      truncated,
      nodes: nodes.sort(
        (left, right) =>
          left.depth - right.depth ||
          traceEndpointKey(left.ref).localeCompare(
            traceEndpointKey(right.ref),
          ),
      ),
      edges: [...includedEdges.values()].sort((left, right) =>
        left.edgeId.localeCompare(right.edgeId),
      ),
    };
  }

  public seedInventory(
    principal: PrincipalContext,
    sku: string,
    location: string,
    quantityOnHand: number,
  ): InventoryRecord {
    requireNonEmpty(sku, "sku");
    requireNonEmpty(location, "location");
    requirePositiveInteger(
      quantityOnHand,
      "quantityOnHand",
      true,
      2_147_483_647,
    );
    const existing = this.store.get<InventoryDbRow>(
      `SELECT * FROM inventory
       WHERE tenant_id = ? AND sku = ? AND location = ?`,
      principal.tenantId,
      sku,
      location,
    );
    if (existing) {
      if (
        existing.quantity_on_hand !== quantityOnHand ||
        existing.quantity_reserved !== 0
      ) {
        throw new KernelError(
          "conflict",
          "Existing inventory cannot be reset through seed_inventory",
        );
      }
      return mapInventory(existing);
    }
    const updatedAt = this.writeTime();
    this.store.run(
      `INSERT INTO inventory (
         tenant_id, sku, location, quantity_on_hand,
         quantity_reserved, version, updated_at
       ) VALUES (?, ?, ?, ?, 0, 1, ?)`,
      principal.tenantId,
      sku,
      location,
      quantityOnHand,
      updatedAt,
    );
    return this.getInventory(principal.tenantId, sku, location);
  }

  public getInventory(
    tenantId: string,
    sku: string,
    location: string,
  ): InventoryRecord {
    const row = this.store.get<InventoryDbRow>(
      `SELECT * FROM inventory
       WHERE tenant_id = ? AND sku = ? AND location = ?`,
      tenantId,
      sku,
      location,
    );
    if (!row) {
      throw new KernelError(
        "not_found",
        `Inventory ${sku} at ${location} was not found`,
      );
    }
    return mapInventory(row);
  }

  public reserveInventory(
    principal: PrincipalContext,
    input: ReserveInventoryInput,
  ): ReservationResult {
    return this.store.transaction(() => {
      requirePositiveInteger(
        input.quantity,
        "quantity",
        false,
        2_147_483_647,
      );
      requirePositiveInteger(input.holdSeconds, "holdSeconds", false, 86_400);
      const operationKey = `reserve:${input.idempotencyKey}`;
      const requestHash = sha256(stableStringify(input));
      const prior = this.getIdempotency<ReservationResult>(
        principal.tenantId,
        operationKey,
        requestHash,
      );
      if (prior) {
        return prior;
      }

      const inventory = this.getInventory(
        principal.tenantId,
        input.sku,
        input.location,
      );
      const allocatable =
        inventory.quantityOnHand - inventory.quantityReserved;
      if (allocatable < input.quantity) {
        throw new KernelError(
          "conflict",
          `Only ${allocatable} units are allocatable`,
        );
      }

      const instanceId = `order:${input.orderId}`;
      const existing = this.tryGetMachine(principal.tenantId, instanceId);
      if (existing) {
        throw new KernelError(
          "conflict",
          `Order machine ${instanceId} already exists with another request`,
        );
      }

      const createdAt = this.writeTime();
      const expiresAt = new Date(
        Date.parse(createdAt) + input.holdSeconds * 1000,
      ).toISOString();
      const data: OrderData = {
        orderId: input.orderId,
        sku: input.sku,
        location: input.location,
        quantity: input.quantity,
        reservationExpiresAt: expiresAt,
      };
      const revision = 1;
      const inventoryChanges = this.store.run(
        `UPDATE inventory
         SET quantity_reserved = quantity_reserved + ?,
             version = version + 1,
             updated_at = ?
         WHERE tenant_id = ? AND sku = ? AND location = ?`,
        input.quantity,
        createdAt,
        principal.tenantId,
        input.sku,
        input.location,
      );
      if (inventoryChanges !== 1) {
        throw new KernelError(
          "conflict",
          "Inventory changed before the reservation could commit",
        );
      }
      this.store.run(
        `INSERT INTO machine_instances (
           tenant_id, instance_id, machine_type, state, data_json,
           revision, created_at, updated_at
         ) VALUES (?, ?, 'retail_order', 'reserved', ?, ?, ?, ?)`,
        principal.tenantId,
        instanceId,
        stableStringify(data),
        revision,
        createdAt,
        createdAt,
      );
      this.appendHistory(
        principal.tenantId,
        instanceId,
        revision,
        "reserve_inventory",
        "new",
        "reserved",
        data,
        createdAt,
      );
      const timerId = deterministicId(
        "timer",
        principal.tenantId,
        instanceId,
        String(revision),
        "reservation_expiry",
      );
      this.store.run(
        `INSERT INTO timers (
           tenant_id, timer_id, instance_id, originating_revision,
           timer_name, due_at, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'reservation_expiry', ?, 'pending', ?, ?)`,
        principal.tenantId,
        timerId,
        instanceId,
        revision,
        expiresAt,
        createdAt,
        createdAt,
      );

      const result: ReservationResult = {
        machine: this.getMachine(principal.tenantId, instanceId),
        inventory: this.getInventory(
          principal.tenantId,
          input.sku,
          input.location,
        ),
        timerId,
      };
      this.putIdempotency(
        principal.tenantId,
        operationKey,
        requestHash,
        result,
      );
      return result;
    });
  }

  public requestPayment(
    principal: PrincipalContext,
    input: PaymentRequestInput,
  ): EffectRecord {
    return this.store.transaction(() => {
      if (!isCanonicalDecimal(input.amount)) {
        throw new KernelError(
          "invalid_input",
          "amount must be a positive decimal string with at most four decimal places",
        );
      }
      const operationKey = `payment:${input.idempotencyKey}`;
      const requestHash = sha256(stableStringify(input));
      const prior = this.getIdempotency<EffectRecord>(
        principal.tenantId,
        operationKey,
        requestHash,
      );
      if (prior) {
        return prior;
      }
      const machine = this.getMachine(
        principal.tenantId,
        input.instanceId,
      );
      if (machine.state !== "reserved") {
        throw new KernelError(
          "conflict",
          `Payment can only start from reserved, not ${machine.state}`,
        );
      }
      const updatedAt = this.writeTime();
      if (updatedAt >= machine.data.reservationExpiresAt) {
        throw new KernelError(
          "conflict",
          "The inventory reservation has expired",
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
        amount: input.amount,
        currency: input.currency,
      };
      const machineChanges = this.store.run(
        `UPDATE machine_instances
         SET state = 'payment_pending', revision = ?, updated_at = ?
         WHERE tenant_id = ? AND instance_id = ? AND revision = ?`,
        nextRevision,
        updatedAt,
        principal.tenantId,
        machine.instanceId,
        machine.revision,
      );
      if (machineChanges !== 1) {
        throw new KernelError(
          "conflict",
          "Order revision changed before payment could start",
        );
      }
      this.appendHistory(
        principal.tenantId,
        machine.instanceId,
        nextRevision,
        "request_payment",
        machine.state,
        "payment_pending",
        machine.data,
        updatedAt,
      );
      this.store.run(
        `UPDATE timers SET status = 'cancelled', updated_at = ?
         WHERE tenant_id = ? AND instance_id = ? AND status = 'pending'`,
        updatedAt,
        principal.tenantId,
        machine.instanceId,
      );
      this.store.run(
        `INSERT INTO effect_intents (
           tenant_id, effect_id, instance_id, originating_revision,
           effect_name, effect_type, outcome_handler, target, status_url,
           request_json, idempotency_key, decision_assertion_id,
           policy_assertion_id, status, attempt_count, outcome_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'payment.capture',
           'retail_order_payment', ?, ?, ?, ?, NULL, NULL,
           'planned', 0, NULL, ?, ?)`,
        principal.tenantId,
        effectId,
        machine.instanceId,
        nextRevision,
        effectName,
        input.paymentTarget,
        input.paymentStatusUrl ?? null,
        stableStringify(request),
        input.idempotencyKey,
        updatedAt,
        updatedAt,
      );
      const effect = this.getEffect(principal.tenantId, effectId);
      this.putIdempotency(
        principal.tenantId,
        operationKey,
        requestHash,
        effect,
      );
      return effect;
    });
  }

  public recordPaymentOutcome(
    principal: PrincipalContext,
    input: PaymentOutcomeInput,
  ): MachineRecord {
    return this.store.transaction(() => {
      const operationKey = `payment-outcome:${input.effectId}:${input.idempotencyKey}`;
      const requestHash = sha256(stableStringify(input));
      const replay = this.getIdempotency<MachineRecord>(
        principal.tenantId,
        operationKey,
        requestHash,
      );
      if (replay) {
        return replay;
      }
      const effect = this.getEffect(principal.tenantId, input.effectId);
      if (effect.status === "succeeded" || effect.status === "failed") {
        if (effect.status !== input.status) {
          throw new KernelError(
            "conflict",
            `Effect is already terminal as ${effect.status}`,
          );
        }
        const terminalMachine = this.getMachine(
          principal.tenantId,
          effect.instanceId,
        );
        this.putIdempotency(
          principal.tenantId,
          operationKey,
          requestHash,
          terminalMachine,
        );
        return terminalMachine;
      }
      const machine = this.getMachine(
        principal.tenantId,
        effect.instanceId,
      );
      if (machine.state !== "payment_pending") {
        throw new KernelError(
          "conflict",
          `Payment outcome cannot apply to machine state ${machine.state}`,
        );
      }

      const attemptNumber = effect.attemptCount + 1;
      const updatedAt = this.writeTime();
      const outcome = input.outcome ?? null;
      this.store.run(
        `INSERT INTO effect_attempts (
           tenant_id, effect_id, attempt_number, status, outcome_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        principal.tenantId,
        effect.effectId,
        attemptNumber,
        input.status,
        outcome === null ? null : stableStringify(outcome),
        updatedAt,
      );
      this.store.run(
        `UPDATE effect_intents
         SET status = ?, attempt_count = ?, outcome_json = ?, updated_at = ?
         WHERE tenant_id = ? AND effect_id = ?`,
        input.status,
        attemptNumber,
        outcome === null ? null : stableStringify(outcome),
        updatedAt,
        principal.tenantId,
        effect.effectId,
      );

      let nextState: MachineState = "payment_pending";
      if (input.status === "succeeded") {
        this.commitReservedInventory(principal.tenantId, machine.data, updatedAt);
        nextState = "confirmed";
      } else if (input.status === "failed") {
        this.releaseReservedInventory(
          principal.tenantId,
          machine.data,
          updatedAt,
        );
        nextState = "failed";
      }

      const nextRevision = machine.revision + 1;
      const machineChanges = this.store.run(
        `UPDATE machine_instances
         SET state = ?, revision = ?, terminal = ?, updated_at = ?
         WHERE tenant_id = ? AND instance_id = ? AND revision = ?`,
        nextState,
        nextRevision,
        nextState === "payment_pending" ? 0 : 1,
        updatedAt,
        principal.tenantId,
        machine.instanceId,
        machine.revision,
      );
      if (machineChanges !== 1) {
        throw new KernelError(
          "conflict",
          "Order revision changed before the payment outcome could commit",
        );
      }
      this.appendHistory(
        principal.tenantId,
        machine.instanceId,
        nextRevision,
        `payment_${input.status}`,
        machine.state,
        nextState,
        machine.data,
        updatedAt,
      );
      const updatedMachine = this.getMachine(
        principal.tenantId,
        machine.instanceId,
      );
      this.putIdempotency(
        principal.tenantId,
        operationKey,
        requestHash,
        updatedMachine,
      );
      return updatedMachine;
    });
  }

  public processDueTimers(
    principal: PrincipalContext,
    asOf?: string,
  ): MachineRecord[] {
    const normalizedAsOf = normalizeIsoTimestamp(
      asOf ?? this.readTime(),
      "asOf",
    );
    const dueTimers = this.store.all<TimerDbRow>(
      `SELECT tenant_id, timer_id, instance_id, originating_revision,
              timer_name, due_at, status
       FROM timers
       WHERE tenant_id = ? AND status = 'pending' AND due_at <= ?
       ORDER BY due_at`,
      principal.tenantId,
      normalizedAsOf,
    );
    const changed: MachineRecord[] = [];
    for (const timer of dueTimers) {
      const result = this.store.transaction(() => {
        const machine = this.getMachine(
          principal.tenantId,
          timer.instance_id,
        );
        if (machine.state !== "reserved") {
          this.store.run(
            `UPDATE timers SET status = 'cancelled', updated_at = ?
             WHERE tenant_id = ? AND timer_id = ?`,
            this.writeTime(),
            principal.tenantId,
            timer.timer_id,
          );
          return null;
        }
        const updatedAt = this.writeTime();
        this.releaseReservedInventory(
          principal.tenantId,
          machine.data,
          updatedAt,
        );
        const nextRevision = machine.revision + 1;
        const machineChanges = this.store.run(
          `UPDATE machine_instances
           SET state = 'cancelled', revision = ?, terminal = 1, updated_at = ?
           WHERE tenant_id = ? AND instance_id = ? AND revision = ?`,
          nextRevision,
          updatedAt,
          principal.tenantId,
          machine.instanceId,
          machine.revision,
        );
        if (machineChanges !== 1) {
          throw new KernelError(
            "conflict",
            "Order revision changed before timer processing could commit",
          );
        }
        this.store.run(
          `UPDATE timers SET status = 'fired', updated_at = ?
           WHERE tenant_id = ? AND timer_id = ?`,
          updatedAt,
          principal.tenantId,
          timer.timer_id,
        );
        this.appendHistory(
          principal.tenantId,
          machine.instanceId,
          nextRevision,
          timer.timer_name,
          machine.state,
          "cancelled",
          machine.data,
          updatedAt,
        );
        return this.getMachine(principal.tenantId, machine.instanceId);
      });
      if (result) {
        changed.push(result);
      }
    }
    return changed;
  }

  public getMachine(tenantId: string, instanceId: string): MachineRecord {
    const row = this.getMachineRow(tenantId, instanceId);
    return mapMachine(row);
  }

  public getMachineRecord(
    tenantId: string,
    instanceId: string,
  ): MachineRecord | WorkflowRecord {
    const row = this.getMachineRow(tenantId, instanceId);
    return row.machine_type === "retail_order"
      ? mapMachine(row)
      : mapWorkflow(row);
  }

  public getWorkflow(
    tenantId: string,
    instanceId: string,
  ): WorkflowRecord {
    const row = this.getMachineRow(tenantId, instanceId);
    if (row.machine_type === "retail_order") {
      throw new KernelError(
        "conflict",
        "Generic workflow operations cannot modify retail orders",
      );
    }
    return mapWorkflow(row);
  }

  public listEffects(tenantId: string, instanceId?: string): EffectRecord[] {
    const rows = instanceId
      ? this.store.all<EffectDbRow>(
          `SELECT * FROM effect_intents
           WHERE tenant_id = ? AND instance_id = ?
           ORDER BY created_at`,
          tenantId,
          instanceId,
        )
      : this.store.all<EffectDbRow>(
          `SELECT * FROM effect_intents
           WHERE tenant_id = ?
           ORDER BY created_at`,
          tenantId,
        );
    return rows.map(mapEffect);
  }

  public recordReceipt(
    principal: PrincipalContext,
    requestId: string,
    operation: string,
    result: JsonValue,
    evidenceManifest: JsonValue,
  ): ExecutionReceipt {
    const snapshotTime = this.writeTime();
    const resultJson = stableStringify(result);
    const resultHash = sha256(resultJson);
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
    const changes = this.store.run(
      `INSERT OR IGNORE INTO execution_receipts (
         tenant_id, receipt_id, request_id, principal_id, purpose, operation,
         snapshot_time, evidence_manifest_json, result_hash, result_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      principal.tenantId,
      receiptId,
      requestId,
      principal.principalId,
      principal.purpose,
      operation,
      snapshotTime,
      stableStringify(evidenceManifest),
      resultHash,
      resultJson,
      snapshotTime,
    );
    if (changes === 0) {
      const existing = this.store.get<ReceiptDbRow>(
        `SELECT * FROM execution_receipts
         WHERE tenant_id = ? AND receipt_id = ?`,
        principal.tenantId,
        receiptId,
      );
      if (!existing) {
        throw new KernelError(
          "conflict",
          "Receipt collision could not be resolved",
        );
      }
      return mapReceipt(existing);
    }
    return {
      tenantId: principal.tenantId,
      receiptId,
      requestId,
      principalId: principal.principalId,
      purpose: principal.purpose,
      operation,
      snapshotTime,
      evidenceManifest,
      resultHash,
      result,
      createdAt: snapshotTime,
    };
  }

  public getIdempotency<T>(
    tenantId: string,
    key: string,
    requestHash: string,
  ): T | null {
    const row = this.store.get<IdempotencyDbRow>(
      `SELECT request_hash, result_json FROM idempotency_results
       WHERE tenant_id = ? AND operation_key = ?`,
      tenantId,
      key,
    );
    if (!row) {
      return null;
    }
    if (row.request_hash !== requestHash) {
      throw new KernelError(
        "conflict",
        `Idempotency key ${key} was already used for a different request`,
      );
    }
    return parseJson<T>(row.result_json);
  }

  public putIdempotency(
    tenantId: string,
    key: string,
    requestHash: string,
    value: unknown,
  ): void {
    const changes = this.store.run(
      `INSERT OR IGNORE INTO idempotency_results (
         tenant_id, operation_key, request_hash, result_json, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
      tenantId,
      key,
      requestHash,
      stableStringify(value),
      this.writeTime(),
    );
    if (changes === 0) {
      this.getIdempotency(tenantId, key, requestHash);
    }
  }

  public readSql(sql: string): SqlRow[] {
    try {
      return this.store.readQuery(sql);
    } catch (error) {
      throw new KernelError(
        "unsafe_query",
        error instanceof Error ? error.message : "Unsafe SQL query",
      );
    }
  }

  public catalog(): CatalogDescription {
    return {
      protocolVersion: "0.1",
      storage: "Node.js embedded SQLite with replaceable storage boundary",
      operations: [
        "put_entity",
        "put_artifact",
        "assert",
        "resolve",
        "search",
        "create_workflow",
        "advance_workflow",
        "request_effect",
        "add_lineage",
        "explain",
        "record_effect_outcome",
        "seed_inventory",
        "reserve_inventory",
        "request_payment",
        "record_payment_outcome",
        "get_machine",
        "list_effects",
        "process_timers",
      ],
      epistemicKinds: [
        "observation",
        "reported_fact",
        "inference",
        "prediction",
        "hypothesis",
        "decision",
        "directive",
        "experience",
      ],
      strengthTypes: [
        "none",
        "rank",
        "probability",
        "interval",
        "evidence_count",
      ],
      machineStates: [
        "new",
        "reserved",
        "payment_pending",
        "confirmed",
        "cancelled",
        "failed",
      ],
      guarantees: [
        "append-oriented bitemporal assertions",
        "explicit conflict and unknown results",
        "FK-backed causal lineage",
        "optimistic generic workflow transitions",
        "transactional inventory and machine transitions",
        "deterministic timer and effect identities",
        "idempotent intent execution",
        "read-only human SQL surface",
      ],
      limitations: [
        "single-process local storage",
        "feature-hash embeddings are plumbing, not semantic model quality",
        "one operation per Agent IR v0.1 envelope",
        "local principal identity is caller-asserted",
      ],
    };
  }

  private writeTime(): string {
    return this.store.allocateTimestamp(this.clock().getTime());
  }

  private readTime(): string {
    return this.store.readTimestamp(this.clock().getTime());
  }

  private requireEntity(tenantId: string, entityId: string): void {
    this.getEntity(tenantId, entityId);
  }

  private loadTraceNode(
    tenantId: string,
    ref: LineageEndpoint,
    depth: number,
  ): { node: TraceNode; truncated: boolean } {
    switch (ref.type) {
      case "artifact": {
        const row = this.store.get<ArtifactDbRow>(
          `SELECT * FROM artifacts
           WHERE tenant_id = ? AND artifact_id = ?`,
          tenantId,
          ref.artifactId,
        );
        if (!row) {
          throw new KernelError("not_found", "Trace artifact was not found");
        }
        return {
          truncated: false,
          node: {
            ref,
            depth,
            label: `Artifact from ${row.source_identity}`,
            record: {
              artifactId: row.artifact_id,
              contentHash: row.content_hash,
              mediaType: row.media_type,
              sourceIdentity: row.source_identity,
              observedAt: row.observed_at,
              sensitivity: row.sensitivity,
              retentionPolicy: row.retention_policy,
              status: row.status,
            },
          },
        };
      }
      case "assertion": {
        const assertion = this.getAssertion(tenantId, ref.assertionId);
        return {
          truncated: false,
          node: {
            ref,
            depth,
            label:
              `${assertion.kind} ${assertion.predicate} = ` +
              typedValueText(assertion.object),
            record: summarizeTraceJson(toJsonValue(assertion)),
          },
        };
      }
      case "workflow_revision": {
        const row = this.store.get<HistoryDbRow>(
          `SELECT history.*, machine.machine_type
           FROM machine_history history
           JOIN machine_instances machine
             ON machine.tenant_id = history.tenant_id
            AND machine.instance_id = history.instance_id
           WHERE history.tenant_id = ?
             AND history.instance_id = ?
             AND history.revision = ?`,
          tenantId,
          ref.instanceId,
          ref.revision,
        );
        if (!row) {
          throw new KernelError(
            "not_found",
            "Trace workflow revision was not found",
          );
        }
        return {
          truncated: false,
          node: {
            ref,
            depth,
            label:
              `${row.machine_type} ${row.transition_name}: ` +
              `${row.prior_state} -> ${row.new_state}`,
            record: summarizeTraceJson({
              instanceId: row.instance_id,
              revision: row.revision,
              eventId: row.event_id,
              workflowType: row.machine_type,
              transitionName: row.transition_name,
              priorState: row.prior_state,
              newState: row.new_state,
              data: parseJson<JsonValue>(row.data_json),
              createdAt: row.created_at,
            }),
          },
        };
      }
      case "effect": {
        const effect = this.getEffect(tenantId, ref.effectId);
        const attemptCount = Number(
          this.store.get<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM effect_attempts
             WHERE tenant_id = ? AND effect_id = ?`,
            tenantId,
            ref.effectId,
          )?.count ?? 0,
        );
        const firstAttempts = this.store.all<EffectAttemptDbRow>(
          `SELECT attempt_number, status, outcome_json, created_at
           FROM effect_attempts
           WHERE tenant_id = ? AND effect_id = ?
           ORDER BY attempt_number
           LIMIT 10`,
          tenantId,
          ref.effectId,
        );
        const lastAttempts =
          attemptCount > 20
            ? this.store
                .all<EffectAttemptDbRow>(
                  `SELECT attempt_number, status, outcome_json, created_at
                   FROM effect_attempts
                   WHERE tenant_id = ? AND effect_id = ?
                   ORDER BY attempt_number DESC
                   LIMIT 10`,
                  tenantId,
                  ref.effectId,
                )
                .reverse()
            : [];
        const attempts = [...firstAttempts, ...lastAttempts].filter(
          (attempt, index, values) =>
            values.findIndex(
              (candidate) =>
                candidate.attempt_number === attempt.attempt_number,
            ) === index,
        );
        return {
          truncated: attemptCount > attempts.length,
          node: {
            ref,
            depth,
            label: `${effect.effectType} effect ${effect.status}`,
            record: {
              effect: summarizeTraceJson(toJsonValue(effect), 4_000),
              attemptCount,
              attemptsTruncated: attemptCount > attempts.length,
              attempts: attempts.map((attempt) => ({
                attemptNumber: attempt.attempt_number,
                status: attempt.status,
                responseStatus: null,
                outcome:
                  attempt.outcome_json === null
                    ? null
                    : summarizeTraceJson(
                        parseJson<JsonValue>(attempt.outcome_json),
                        1_000,
                      ),
                createdAt: attempt.created_at,
              })),
            },
          },
        };
      }
    }
  }

  private lineageForEndpoint(
    tenantId: string,
    endpoint: LineageEndpoint,
  ): {
    edges: LineageEdgeRecord[];
    truncated: boolean;
  } {
    let condition: string;
    let values: SqlValue[];
    switch (endpoint.type) {
      case "artifact":
        condition = "(from_artifact_id = ? OR to_artifact_id = ?)";
        values = [endpoint.artifactId, endpoint.artifactId];
        break;
      case "assertion":
        condition = "(from_assertion_id = ? OR to_assertion_id = ?)";
        values = [endpoint.assertionId, endpoint.assertionId];
        break;
      case "workflow_revision":
        condition = `(
          (from_instance_id = ? AND from_revision = ?)
          OR (to_instance_id = ? AND to_revision = ?)
        )`;
        values = [
          endpoint.instanceId,
          endpoint.revision,
          endpoint.instanceId,
          endpoint.revision,
        ];
        break;
      case "effect":
        condition = "(from_effect_id = ? OR to_effect_id = ?)";
        values = [endpoint.effectId, endpoint.effectId];
        break;
    }
    const rows = this.store.all<LineageDbRow>(
      `SELECT * FROM lineage_edges
       WHERE tenant_id = ? AND ${condition}
       ORDER BY created_at, edge_id
       LIMIT 2001`,
      tenantId,
      ...values,
    );
    return {
      edges: rows.slice(0, 2_000).map(mapLineage),
      truncated: rows.length > 2_000,
    };
  }

  private requireCurrentAssertionKind(
    tenantId: string,
    assertionId: string,
    kind: EpistemicKind,
  ): AssertionRecord {
    const now = this.readTime();
    const row = this.store.get<AssertionDbRow>(
      `SELECT * FROM assertions
       WHERE tenant_id = ? AND assertion_id = ?
         AND kind = ? AND status = 'active'
         AND system_from <= ?
         AND (system_to IS NULL OR system_to > ?)
         AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to > ?)`,
      tenantId,
      assertionId,
      kind,
      now,
      now,
      now,
      now,
    );
    if (!row) {
      throw new KernelError(
        "conflict",
        `Active ${kind} assertion ${assertionId} was not found`,
      );
    }
    return mapAssertion(row);
  }

  private insertLineage(
    principal: PrincipalContext,
    input: {
      relation: LineageRelation;
      from: LineageEndpoint;
      to: LineageEndpoint;
    },
  ): LineageEdgeRecord {
    this.validateLineage(principal.tenantId, input);
    const edgeId = deterministicId(
      "lineage",
      principal.tenantId,
      input.relation,
      stableStringify(input.from),
      stableStringify(input.to),
    );
    const from = lineageColumns(input.from);
    const to = lineageColumns(input.to);
    const createdAt = this.writeTime();
    this.store.run(
      `INSERT OR IGNORE INTO lineage_edges (
         tenant_id, edge_id, relation,
         from_artifact_id, from_assertion_id, from_instance_id,
         from_revision, from_effect_id,
         to_artifact_id, to_assertion_id, to_instance_id,
         to_revision, to_effect_id, created_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      principal.tenantId,
      edgeId,
      input.relation,
      from.artifactId,
      from.assertionId,
      from.instanceId,
      from.revision,
      from.effectId,
      to.artifactId,
      to.assertionId,
      to.instanceId,
      to.revision,
      to.effectId,
      principal.principalId,
      createdAt,
    );
    const row = this.store.get<LineageDbRow>(
      `SELECT * FROM lineage_edges
       WHERE tenant_id = ? AND edge_id = ?`,
      principal.tenantId,
      edgeId,
    );
    if (!row) {
      throw new KernelError("conflict", "Lineage edge was not persisted");
    }
    return mapLineage(row);
  }

  private validateLineage(
    tenantId: string,
    input: {
      relation: LineageRelation;
      from: LineageEndpoint;
      to: LineageEndpoint;
    },
  ): void {
    if (stableStringify(input.from) === stableStringify(input.to)) {
      throw new KernelError("invalid_input", "Lineage cannot link a node to itself");
    }
    this.requireLineageEndpoint(tenantId, input.from);
    this.requireLineageEndpoint(tenantId, input.to);
    switch (input.relation) {
      case "evidence_for":
        requireLineageTypes(input, "artifact", "assertion");
        return;
      case "supports":
      case "contradicts":
        requireLineageTypes(input, "assertion", "assertion");
        return;
      case "governs":
        if (
          input.from.type !== "assertion" ||
          (input.to.type !== "assertion" && input.to.type !== "effect")
        ) {
          throw new KernelError(
            "invalid_input",
            "governs requires an assertion source and assertion or effect target",
          );
        }
        this.requireCurrentAssertionKind(
          tenantId,
          input.from.assertionId,
          "directive",
        );
        return;
      case "authorizes":
        if (
          input.from.type !== "assertion" ||
          input.to.type !== "effect"
        ) {
          throw new KernelError(
            "invalid_input",
            "authorizes requires assertion to effect",
          );
        }
        this.requireCurrentAssertionKind(
          tenantId,
          input.from.assertionId,
          "decision",
        );
        return;
      case "produces":
        requireLineageTypes(input, "workflow_revision", "effect");
        return;
      case "verifies":
        requireLineageTypes(input, "effect", "assertion");
        if (input.to.type === "assertion") {
          this.requireCurrentAssertionKind(
            tenantId,
            input.to.assertionId,
            "observation",
          );
        }
        return;
    }
  }

  private requireLineageEndpoint(
    tenantId: string,
    endpoint: LineageEndpoint,
  ): void {
    let row: SqlRow | undefined;
    switch (endpoint.type) {
      case "artifact":
        row = this.store.get(
          `SELECT 1 AS found FROM artifacts
           WHERE tenant_id = ? AND artifact_id = ?`,
          tenantId,
          endpoint.artifactId,
        );
        break;
      case "assertion":
        row = this.store.get(
          `SELECT 1 AS found FROM assertions
           WHERE tenant_id = ? AND assertion_id = ?`,
          tenantId,
          endpoint.assertionId,
        );
        break;
      case "workflow_revision":
        row = this.store.get(
          `SELECT 1 AS found FROM machine_history
           WHERE tenant_id = ? AND instance_id = ? AND revision = ?`,
          tenantId,
          endpoint.instanceId,
          endpoint.revision,
        );
        break;
      case "effect":
        row = this.store.get(
          `SELECT 1 AS found FROM effect_intents
           WHERE tenant_id = ? AND effect_id = ?`,
          tenantId,
          endpoint.effectId,
        );
        break;
    }
    if (!row) {
      throw new KernelError(
        "not_found",
        `Lineage ${endpoint.type} endpoint was not found`,
      );
    }
  }

  private tryGetMachine(
    tenantId: string,
    instanceId: string,
  ): MachineRecord | null {
    const row = this.store.get<MachineDbRow>(
      `SELECT * FROM machine_instances
       WHERE tenant_id = ? AND instance_id = ?`,
      tenantId,
      instanceId,
    );
    return row ? mapMachine(row) : null;
  }

  private getMachineRow(
    tenantId: string,
    instanceId: string,
  ): MachineDbRow {
    const row = this.store.get<MachineDbRow>(
      `SELECT * FROM machine_instances
       WHERE tenant_id = ? AND instance_id = ?`,
      tenantId,
      instanceId,
    );
    if (!row) {
      throw new KernelError(
        "not_found",
        `Machine ${instanceId} was not found`,
      );
    }
    return row;
  }

  private getEffect(tenantId: string, effectId: string): EffectRecord {
    const row = this.store.get<EffectDbRow>(
      `SELECT * FROM effect_intents
       WHERE tenant_id = ? AND effect_id = ?`,
      tenantId,
      effectId,
    );
    if (!row) {
      throw new KernelError("not_found", `Effect ${effectId} was not found`);
    }
    return mapEffect(row);
  }

  private appendHistory(
    tenantId: string,
    instanceId: string,
    revision: number,
    transitionName: string,
    priorState: string,
    newState: string,
    data: JsonValue | OrderData,
    createdAt: string,
  ): void {
    const eventId = deterministicId(
      "event",
      tenantId,
      instanceId,
      String(revision),
      transitionName,
    );
    this.store.run(
      `INSERT INTO machine_history (
         tenant_id, instance_id, revision, event_id, transition_name,
         prior_state, new_state, data_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      tenantId,
      instanceId,
      revision,
      eventId,
      transitionName,
      priorState,
      newState,
      stableStringify(data),
      createdAt,
    );
  }

  private releaseReservedInventory(
    tenantId: string,
    order: OrderData,
    updatedAt: string,
  ): void {
    const changes = this.store.run(
      `UPDATE inventory
       SET quantity_reserved = quantity_reserved - ?,
           version = version + 1,
           updated_at = ?
       WHERE tenant_id = ? AND sku = ? AND location = ?
         AND quantity_reserved >= ?`,
      order.quantity,
      updatedAt,
      tenantId,
      order.sku,
      order.location,
      order.quantity,
    );
    if (changes !== 1) {
      throw new KernelError(
        "conflict",
        "Reserved inventory was unavailable for release",
      );
    }
  }

  private commitReservedInventory(
    tenantId: string,
    order: OrderData,
    updatedAt: string,
  ): void {
    const changes = this.store.run(
      `UPDATE inventory
       SET quantity_on_hand = quantity_on_hand - ?,
           quantity_reserved = quantity_reserved - ?,
           version = version + 1,
           updated_at = ?
       WHERE tenant_id = ? AND sku = ? AND location = ?
         AND quantity_on_hand >= ?
         AND quantity_reserved >= ?`,
      order.quantity,
      order.quantity,
      updatedAt,
      tenantId,
      order.sku,
      order.location,
      order.quantity,
      order.quantity,
    );
    if (changes !== 1) {
      throw new KernelError(
        "conflict",
        "Reserved inventory was unavailable for commit",
      );
    }
  }

  private ftsMatches(tenantId: string, text: string): Set<string> {
    const tokens = tokenize(text).slice(0, 16);
    if (tokens.length === 0) {
      return new Set();
    }
    const query = tokens
      .map((token) => `"${token.replaceAll('"', '""')}"`)
      .join(" OR ");
    const rows = this.store.all<SqlRow>(
      `SELECT assertion_id
       FROM assertion_fts
       WHERE assertion_fts MATCH ? AND tenant_id = ?
       LIMIT 500`,
      query,
      tenantId,
    );
    return new Set(rows.map((row) => requireRowString(row, "assertion_id")));
  }

  private assertionSearchText(assertion: AssertionRecord): string {
    let artifactText = "";
    if (assertion.sourceArtifactId) {
      const artifact = this.getArtifact(
        assertion.tenantId,
        assertion.sourceArtifactId,
      );
      if (artifact.status === "active") {
        artifactText = `${artifact.sourceIdentity} ${artifact.content.slice(
          0,
          4_096,
        )}`;
      }
    }
    return [
      assertion.subjectEntityId,
      assertion.predicate.replaceAll("_", " "),
      typedValueText(assertion.object),
      assertion.kind.replaceAll("_", " "),
      assertion.perspective,
      artifactText,
    ].join(" ");
  }

  private graphDistances(
    tenantId: string,
    startEntityId: string,
    maxDepth: number,
    validAt: string,
    systemAt: string,
  ): Map<string, number> {
    this.requireEntity(tenantId, startEntityId);
    const boundedDepth = clamp(maxDepth, 0, 8);
    const distances = new Map<string, number>([[startEntityId, 0]]);
    let frontier = [startEntityId];

    for (let depth = 1; depth <= boundedDepth; depth += 1) {
      const next: string[] = [];
      for (const entityId of frontier) {
        const outgoing = this.queryAssertions(tenantId, {
          subjectEntityId: entityId,
          validAt,
          systemAt,
          limit: 1000,
        }).filter((assertion) => assertion.object.type === "entity");
        const incoming = this.queryAssertionsByObject(
          tenantId,
          entityId,
          validAt,
          systemAt,
        );
        for (const assertion of [...outgoing, ...incoming]) {
          const neighbor =
            assertion.subjectEntityId === entityId
              ? assertion.object.type === "entity"
                ? assertion.object.value
                : null
              : assertion.subjectEntityId;
          if (neighbor && !distances.has(neighbor)) {
            distances.set(neighbor, depth);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) {
        break;
      }
    }
    return distances;
  }

  private queryAssertionsByObject(
    tenantId: string,
    objectEntityId: string,
    validAt: string,
    systemAt: string,
  ): AssertionRecord[] {
    return this.store
      .all<AssertionDbRow>(
        `SELECT * FROM assertions
         WHERE tenant_id = ?
           AND object_entity_id = ?
           AND system_from <= ?
           AND (system_to IS NULL OR system_to > ?)
           AND valid_from <= ?
           AND (valid_to IS NULL OR valid_to > ?)
           AND status NOT IN ('quarantined', 'deleted')
         LIMIT 1000`,
        tenantId,
        objectEntityId,
        systemAt,
        systemAt,
        validAt,
        validAt,
      )
      .map(mapAssertion);
  }

  private queryApplicableAssertions(
    tenantId: string,
    subjectEntityId: string,
    predicate: string,
    perspective: string | undefined,
    validAt: string,
    systemAt: string,
  ): AssertionRecord[] {
    const perspectiveClause = perspective ? "AND perspective = ?" : "";
    const params: SqlValue[] = [
      tenantId,
      subjectEntityId,
      predicate,
      systemAt,
      systemAt,
      validAt,
      validAt,
    ];
    if (perspective) {
      params.push(perspective);
    }
    return this.store
      .all<AssertionDbRow>(
        `SELECT * FROM assertions
         WHERE tenant_id = ?
           AND subject_entity_id = ?
           AND predicate = ?
           AND system_from <= ?
           AND (system_to IS NULL OR system_to > ?)
           AND valid_from <= ?
           AND (valid_to IS NULL OR valid_to > ?)
           AND status NOT IN ('quarantined', 'deleted')
           ${perspectiveClause}
         ORDER BY authority DESC, system_from DESC`,
        ...params,
      )
      .map(mapAssertion);
  }
}

function mapAssertion(row: AssertionDbRow): AssertionRecord {
  return {
    tenantId: row.tenant_id,
    assertionId: row.assertion_id,
    subjectEntityId: row.subject_entity_id,
    predicate: row.predicate,
    object: parseJson<TypedValue>(row.object_json),
    kind: row.kind as EpistemicKind,
    perspective: row.perspective,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    systemFrom: row.system_from,
    systemTo: row.system_to,
    strength: parseJson<Strength>(row.strength_json),
    authority: row.authority,
    status: row.status as AssertionStatus,
    sourceArtifactId: row.source_artifact_id,
    basis:
      row.basis_json === null ? null : parseJson<JsonValue>(row.basis_json),
    supersedesAssertionId: row.supersedes_assertion_id,
    createdBy: row.created_by,
  };
}

function mapInventory(row: InventoryDbRow): InventoryRecord {
  return {
    tenantId: row.tenant_id,
    sku: row.sku,
    location: row.location,
    quantityOnHand: row.quantity_on_hand,
    quantityReserved: row.quantity_reserved,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function mapMachine(row: MachineDbRow): MachineRecord {
  if (row.machine_type !== "retail_order") {
    throw new KernelError(
      "conflict",
      `Machine ${row.instance_id} is not a retail order`,
    );
  }
  return {
    tenantId: row.tenant_id,
    instanceId: row.instance_id,
    machineType: "retail_order",
    state: row.state as MachineState,
    data: parseJson<OrderData>(row.data_json),
    revision: row.revision,
    terminal: row.terminal === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkflow(row: MachineDbRow): WorkflowRecord {
  return {
    tenantId: row.tenant_id,
    instanceId: row.instance_id,
    machineType: row.machine_type,
    state: row.state,
    data: parseJson<JsonValue>(row.data_json),
    revision: row.revision,
    terminal: row.terminal === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEffect(row: EffectDbRow): EffectRecord {
  return {
    tenantId: row.tenant_id,
    effectId: row.effect_id,
    instanceId: row.instance_id,
    originatingRevision: row.originating_revision,
    effectName: row.effect_name,
    effectType: row.effect_type,
    outcomeHandler: row.outcome_handler as
      | "retail_order_payment"
      | "none",
    target: row.target,
    statusUrl: row.status_url,
    request: parseJson<JsonValue>(row.request_json),
    idempotencyKey: row.idempotency_key,
    decisionAssertionId: row.decision_assertion_id,
    policyAssertionId: row.policy_assertion_id,
    status: row.status as EffectStatus,
    attemptCount: row.attempt_count,
    outcome:
      row.outcome_json === null
        ? null
        : parseJson<JsonValue>(row.outcome_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLineage(row: LineageDbRow): LineageEdgeRecord {
  return {
    tenantId: row.tenant_id,
    edgeId: row.edge_id,
    relation: row.relation as LineageRelation,
    from: lineageEndpointFromRow(row, "from"),
    to: lineageEndpointFromRow(row, "to"),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function lineageEndpointFromRow(
  row: LineageDbRow,
  side: "from" | "to",
): LineageEndpoint {
  const artifactId =
    side === "from" ? row.from_artifact_id : row.to_artifact_id;
  if (artifactId) {
    return { type: "artifact", artifactId };
  }
  const assertionId =
    side === "from" ? row.from_assertion_id : row.to_assertion_id;
  if (assertionId) {
    return { type: "assertion", assertionId };
  }
  const instanceId =
    side === "from" ? row.from_instance_id : row.to_instance_id;
  const revision =
    side === "from" ? row.from_revision : row.to_revision;
  if (instanceId && revision !== null) {
    return { type: "workflow_revision", instanceId, revision };
  }
  const effectId =
    side === "from" ? row.from_effect_id : row.to_effect_id;
  if (effectId) {
    return { type: "effect", effectId };
  }
  throw new Error(`Lineage ${side} endpoint is invalid`);
}

function lineageColumns(endpoint: LineageEndpoint): {
  artifactId: string | null;
  assertionId: string | null;
  instanceId: string | null;
  revision: number | null;
  effectId: string | null;
} {
  return {
    artifactId: endpoint.type === "artifact" ? endpoint.artifactId : null,
    assertionId:
      endpoint.type === "assertion" ? endpoint.assertionId : null,
    instanceId:
      endpoint.type === "workflow_revision" ? endpoint.instanceId : null,
    revision:
      endpoint.type === "workflow_revision" ? endpoint.revision : null,
    effectId: endpoint.type === "effect" ? endpoint.effectId : null,
  };
}

function requireLineageTypes(
  input: {
    relation: LineageRelation;
    from: LineageEndpoint;
    to: LineageEndpoint;
  },
  fromType: LineageEndpoint["type"],
  toType: LineageEndpoint["type"],
): void {
  if (input.from.type !== fromType || input.to.type !== toType) {
    throw new KernelError(
      "invalid_input",
      `${input.relation} requires ${fromType} to ${toType}`,
    );
  }
}

function mapReceipt(row: ReceiptDbRow): ExecutionReceipt {
  return {
    tenantId: row.tenant_id,
    receiptId: row.receipt_id,
    requestId: row.request_id,
    principalId: row.principal_id,
    purpose: row.purpose,
    operation: row.operation,
    snapshotTime: row.snapshot_time,
    evidenceManifest: parseJson<JsonValue>(row.evidence_manifest_json),
    resultHash: row.result_hash,
    result: parseJson<JsonValue>(row.result_json),
    createdAt: row.created_at,
  };
}

function groupAssertions(
  assertions: AssertionRecord[],
): Map<string, AssertionRecord[]> {
  const groups = new Map<string, AssertionRecord[]>();
  for (const assertion of assertions) {
    const key = stableStringify(assertion.object);
    const group = groups.get(key) ?? [];
    group.push(assertion);
    groups.set(key, group);
  }
  return groups;
}

function chooseLatest(assertions: AssertionRecord[]): AssertionRecord {
  const selected = [...assertions].sort((left, right) =>
    right.systemFrom.localeCompare(left.systemFrom),
  )[0];
  if (!selected) {
    throw new KernelError("not_found", "No assertion was available");
  }
  return selected;
}

function chooseHighestAuthority(
  assertions: AssertionRecord[],
): AssertionRecord {
  const selected = [...assertions].sort(
    (left, right) =>
      right.authority - left.authority ||
      right.systemFrom.localeCompare(left.systemFrom),
  )[0];
  if (!selected) {
    throw new KernelError("not_found", "No assertion was available");
  }
  return selected;
}

function minimumGraphDistance(
  assertion: AssertionRecord,
  distances: Map<string, number>,
): number | null {
  const values: number[] = [];
  const subjectDistance = distances.get(assertion.subjectEntityId);
  if (subjectDistance !== undefined) {
    values.push(subjectDistance);
  }
  if (assertion.object.type === "entity") {
    const objectDistance = distances.get(assertion.object.value);
    if (objectDistance !== undefined) {
      values.push(objectDistance);
    }
  }
  return values.length === 0 ? null : Math.min(...values);
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256(...parts).slice(0, 32)}`;
}

function validateStrength(strength: Strength): void {
  if (strength.type === "probability") {
    if (
      !Number.isFinite(strength.value) ||
      strength.value < 0 ||
      strength.value > 1
    ) {
      throw new KernelError(
        "invalid_input",
        "Probability strength must be between 0 and 1",
      );
    }
  }
  if (
    strength.type === "interval" &&
    (!Number.isFinite(strength.low) ||
      !Number.isFinite(strength.high) ||
      strength.high < strength.low)
  ) {
    throw new KernelError(
      "invalid_input",
      "Interval strength must have finite low <= high",
    );
  }
  if (
    strength.type === "evidence_count" &&
    (strength.supporting < 0 ||
      strength.considered < strength.supporting ||
      !Number.isInteger(strength.supporting) ||
      !Number.isInteger(strength.considered))
  ) {
    throw new KernelError(
      "invalid_input",
      "Evidence count must have 0 <= supporting <= considered",
    );
  }
}

function requireNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new KernelError("invalid_input", `${fieldName} is required`);
  }
}

function requirePositiveInteger(
  value: number,
  fieldName: string,
  allowZero = false,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new KernelError(
      "invalid_input",
      `${fieldName} must be an integer between ${minimum} and ${maximum}`,
    );
  }
}

function isCanonicalDecimal(value: string): boolean {
  return (
    /^(0|[1-9]\d{0,15})(\.\d{1,4})?$/.test(value) &&
    Number(value) > 0
  );
}

function requireRowString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function operationEvidence(result: unknown): JsonValue {
  if (isAssertionRecord(result)) {
    return {
      assertionIds: [result.assertionId],
      artifactIds: result.sourceArtifactId ? [result.sourceArtifactId] : [],
    };
  }
  if (isResolutionResult(result)) {
    return {
      assertionIds: result.candidates.map(
        (candidate) => candidate.assertionId,
      ),
    };
  }
  if (Array.isArray(result) && result.every(isSearchHit)) {
    return {
      assertionIds: result.map((hit) => hit.assertion.assertionId),
    };
  }
  if (isEffectRecord(result)) {
    return { effectIds: [result.effectId], machineIds: [result.instanceId] };
  }
  if (isLineageEdgeRecord(result)) {
    return { lineageEdgeIds: [result.edgeId] };
  }
  if (isMachineRecord(result)) {
    return { machineIds: [result.instanceId] };
  }
  return {};
}

function isAssertionRecord(value: unknown): value is AssertionRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "assertionId" in value &&
    "predicate" in value
  );
}

function isResolutionResult(value: unknown): value is ResolutionResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "candidates" in value &&
    "conflicts" in value &&
    "policy" in value
  );
}

function isSearchHit(value: unknown): value is SearchHit {
  return (
    value !== null &&
    typeof value === "object" &&
    "combinedScore" in value &&
    "assertion" in value
  );
}

function isEffectRecord(value: unknown): value is EffectRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "effectId" in value &&
    "effectName" in value
  );
}

function isLineageEdgeRecord(value: unknown): value is LineageEdgeRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "edgeId" in value &&
    "relation" in value
  );
}

function isMachineRecord(
  value: unknown,
): value is MachineRecord | WorkflowRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "instanceId" in value &&
    "state" in value
  );
}

export function jsonResult(value: unknown): JsonValue {
  return toJsonValue(value);
}
