# Agent-First Database Proof of Concept

## Falsifiable implementation and benchmark blueprint

Research snapshot: 2026-09-01

## 1. Purpose

The proof of concept must determine whether an agent-first data contract creates
measurable value. It must not assume that a novel database is better because it
has one endpoint, a new syntax, or an integrated demo.

The proposition under test is:

> Under identical semantics, data, model, authority, and failure conditions, an
> agent-first data system can complete more authorized multi-step tasks with
> fewer interaction round trips and less context while preserving or improving
> correctness, recovery, provenance, latency, throughput, freshness, cost, and
> human auditability.

The prototype may use existing storage engines internally. The first milestone
is to validate the logical model and execution contract. A custom storage engine
is justified only if measurement reveals a structural limitation.

## 2. Hypotheses

| ID | Hypothesis | Measurement |
| --- | --- | --- |
| H1 | A typed intent/effect IR reduces agent interaction overhead | Logical tool calls, network round trips, context bytes, input tokens |
| H2 | Typed epistemic state improves answers under conflict, staleness, and missing evidence | Final-state accuracy, calibrated abstention, conflict detection, stale-fact use |
| H3 | One snapshot-coherent hybrid plan improves multi-source task success | Task success, no future-data leakage, snapshot candidate recall, and trace validity |
| H4 | Transactionally coupled machine state and effect intent improve recovery | Oracle-equivalent final state after crash, retry, timeout, and duplicate delivery |
| H5 | Provenance-by-default makes consequential effects reconstructable | Mandatory receipt coverage and evidence-resolution rate |
| H6 | Engine-enforced delegation prevents unauthorized effects despite prompt injection | Adversarial cross-tenant and over-budget effect tests |
| H7 | The architecture remains operationally competitive | p95/p99 latency, throughput, freshness, compute/storage cost, operator steps |

The project fails as a general database thesis if it cannot demonstrate H1 or H3
without violating H4-H7. It may still be valuable as a governance or workflow
layer.

## 3. Scope and non-goals

### 3.1 In scope

- serializable transactional records;
- typed assertions, contradiction, and bitemporal history;
- text, vector, graph, relational, and temporal query composition;
- analytical snapshots and incremental projections;
- durable state machines, approvals, timers, retries, and effects;
- an agent-native IR and MCP adapter;
- SQL views and operational tooling for people;
- local disk and object-store artifacts;
- retail and non-retail benchmark scenarios;
- deterministic correctness oracles and failure injection.

### 3.2 Not initially in scope

- inventing a new consensus or MVCC algorithm;
- hyperscale multi-region production deployment;
- a general probabilistic query engine;
- automatic causal inference;
- arbitrary ontology learning without governance;
- training a foundation model;
- proving that one physical format is optimal for every workload;
- claiming exactly-once execution for non-cooperating external systems.

## 4. Comparison design

Use two baselines so the prototype cannot win by changing several variables at
once.

### 4.1 Baseline A: same substrate and equivalent server-side composition

The primary conventional baseline receives the same PostgreSQL data, indexes,
transaction capabilities, server-side composition, bounded result shape, and
single-RPC option as the prototype. It may use SQL, stored procedures, and a
conventional typed application API, but it does not receive the proposed
epistemic kinds, default evidence contract, state/effect IR, or context-aware
planning semantics.

Run a paired factorial design:

```text
A1 conventional model + one compound server RPC
A2 conventional model + separate conventional tools
B1 agent-first model + one compound Agent IR request
B2 agent-first model + decomposed Agent IR operations
```

The separate conventional tools in A2 are:

```text
sql_query
sql_mutate
vector_search
graph_expand
artifact_fetch
workflow_command
effect_execute
```

In A1, equivalent joins, policy checks, transactions, and orchestration may run
server-side. Both A1 and B1 must receive the same semantic resolver and policy
capabilities where those are not the feature under test.

This design separates API packaging effects from gains attributable to the
Agent IR, epistemic model, result contract, and transactional state/effect
coupling.

### 4.2 Baseline B: best-of-breed composition

Use a declared composition such as:

```text
PostgreSQL + pgvector
graph database or Graphiti-compatible backend
object storage
Temporal, DBOS, or Restate
stream/log processor
application-side policy and agent orchestration
```

Exact products and versions must be frozen before the run. Both systems receive
the same engineering and tuning budget.

This baseline tests whether the integrated design competes with specialized
components rather than only with an intentionally weak API.

### 4.3 Reference oracle

Build an independent deterministic oracle:

- event-sourced state machine;
- policy evaluator;
- inventory and money invariants;
- temporal validity checker;
- expected effect ledger;
- provenance requirements;
- final-state and trace validator.

The implementation under test must not share transition or validation code with
the oracle.

## 5. Concrete prototype stack

### 5.1 Recommended first implementation

| Layer | Initial choice | Reason |
| --- | --- | --- |
| Transaction kernel | PostgreSQL with serializable transactions | Mature correctness, SQL, range types, JSON, full text, broad tooling |
| Vector projection | pgvector | Keeps vector candidates near authoritative data and supports exact/ANN comparison |
| Graph projection | Typed edge/relation tables plus recursive SQL | Avoids a second authority during semantic validation |
| Text projection | PostgreSQL full-text search | Sufficient for the first controlled benchmark |
| Analytical execution | DuckDB over Parquet exports | Embedded, reproducible local analytics without a warehouse service |
| Artifact storage | Local content-addressed directory plus S3-compatible object storage | Exercises local and cloud-style cold tiers |
| Core service | Rust | Strong types, predictable concurrency, Arrow/DataFusion ecosystem access |
| Agent adapter | Official MCP SDK in the most mature supported language | Keep MCP at the boundary, not in the kernel |
| Telemetry | OpenTelemetry | End-to-end trace, cost, retry, and effect instrumentation |
| Fault injection | Process kill points, network proxy, sink simulators | Reproduce ambiguity around durable boundaries |

Rust is recommended if the prototype may evolve into an engine. A faster
application-language implementation is acceptable for Phase 0, but the
substrate benchmark must separate service runtime overhead from database
behavior.

### 5.2 Later substitutions

Only after the initial measurements:

- FoundationDB for a custom ordered transactional key-value kernel;
- Lance for versioned multimodal object-store projections;
- DataFusion or Velox for distributed analytical execution;
- Materialize or DBSP for incremental derived state;
- Redpanda/Kafka for high-rate stream transport;
- a dedicated graph engine if recursive SQL becomes a measured bottleneck.

## 6. Persistent schema

The following is a logical schema. Physical normalization may change after
profiling.

### 6.0 Mandatory tenancy and scope rule

Every persisted row, cache entry, projection object, artifact, result handle,
receipt, and object-store key must carry an authenticated tenant/scope identity.
No security boundary may depend on a tenant ID supplied only by an agent.

Implementation requirements:

- tenant-inclusive primary and foreign keys;
- PostgreSQL row-level security using a connection/session tenant context set
  only by trusted authentication middleware;
- separate administrative roles that cannot be reached through agent queries;
- tenant-bound cache keys, projection manifests, and signed object/result URLs;
- property and fuzz tests across SQL, MCP, workers, caches, indexes, and object
  retrieval;
- a reserved system tenant plus explicit grants for shared catalog objects,
  rather than nullable tenant identity.

### 6.1 Identity and authoritative records

```text
entity(
  tenant_id,
  entity_id,
  entity_type,
  canonical_name,
  created_tx,
  retired_tx,
  primary key (tenant_id, entity_id)
)

entity_alias(
  tenant_id,
  alias_namespace,
  alias_value,
  entity_id,
  valid_time,
  system_time,
  status
)

record_version(
  tenant_id,
  record_type,
  record_id,
  revision,
  payload,
  valid_time,
  system_time,
  committed_tx,
  primary key (tenant_id, record_type, record_id, revision)
)
```

Authoritative projections may use normalized type-specific tables for
constraints and performance. `record_version` provides a common temporal and
receipt surface; it need not replace every typed table.

### 6.2 Assertions and evidence

```text
assertion(
  tenant_id,
  assertion_id,
  act,
  fact_type,
  subject_entity_id,
  predicate_id,
  object_entity_id,
  typed_value,
  relation_roles,
  epistemic_kind,
  perspective_id,
  valid_time,
  system_time,
  strength_type,
  strength_payload,
  authority_class,
  status,
  basis_id,
  schema_version,
  committed_tx
)

artifact(
  tenant_id,
  artifact_id,
  content_hash,
  media_type,
  storage_uri,
  source_identity,
  observed_at,
  sensitivity,
  retention_policy,
  encryption_domain,
  status,
  deleted_at,
  deletion_proof_hash
)

derivation(
  tenant_id,
  derivation_id,
  method_type,
  rule_or_model_id,
  method_version,
  input_snapshot,
  parameters_hash,
  output_schema,
  created_tx
)

derivation_input(
  tenant_id,
  derivation_id,
  input_kind,
  input_id,
  role
)

assertion_evidence(
  tenant_id,
  assertion_id,
  artifact_id,
  evidence_role,
  locator
)
```

Use PostgreSQL range types and GiST indexes for valid/system time. Store typed
values in dedicated columns where high-value predicates need constraints and
statistics; use a tagged JSON representation only for the long tail.

### 6.3 Projection metadata

```text
commit_outbox(
  tenant_id,
  source_commit,
  log_position,
  event_type,
  object_id,
  payload_hash,
  published_state
)

projection_definition(
  tenant_id,
  projection_id,
  projection_type,
  definition_version,
  policy_scope,
  model_or_index_version,
  status,
  rebuild_recipe
)

projection_epoch(
  tenant_id,
  projection_id,
  projection_epoch_id,
  source_commit_from,
  source_commit_through,
  source_log_position,
  catalog_version,
  model_or_index_version,
  immutable_manifest_uri,
  immutable_manifest_hash,
  completeness_mode,
  published_at,
  retired_at,
  primary key (tenant_id, projection_id, projection_epoch_id)
)

embedding_projection(
  tenant_id,
  projection_id,
  projection_epoch_id,
  source_kind,
  source_id,
  model_id,
  model_version,
  embedding
)

graph_projection_edge(
  tenant_id,
  projection_id,
  projection_epoch_id,
  source_assertion_id,
  from_entity_id,
  relation_type,
  to_entity_id,
  valid_time,
  system_time
)
```

Publication protocol:

1. the authoritative transaction commits a `commit_outbox` position;
2. workers build immutable projection/object artifacts for a declared commit
   interval;
3. workers verify checksums and the declared completeness mode;
4. one transaction publishes the `projection_epoch` manifest;
5. queries may use only published compatible epochs;
6. incomplete uploads or index builds remain quarantined and do not advance the
   visible epoch.

The benchmark must stagger projection updates deliberately and verify both that
future records never leak into an older snapshot and that records valid at that
snapshot are not silently omitted beyond the declared approximate-recall mode.

### 6.4 Durable machines and effects

```text
machine_definition(
  tenant_id,
  machine_type,
  semantic_version,
  definition_hash,
  definition,
  policy_refs,
  status
)

machine_instance(
  tenant_id,
  instance_id,
  machine_type,
  pinned_version,
  active_state,
  state_data,
  revision,
  deadline,
  lease_epoch,
  branch_parent,
  status
)

machine_inbox(
  tenant_id,
  instance_id,
  source,
  source_event_id,
  event_payload,
  accepted_revision,
  outcome,
  unique (tenant_id, source, source_event_id)
)

machine_history(
  tenant_id,
  instance_id,
  revision,
  event_id,
  causation_id,
  correlation_id,
  prior_state_hash,
  transition_id,
  new_state_hash,
  policy_decision_id,
  committed_tx
)

timer(
  tenant_id,
  timer_id,
  instance_id,
  originating_revision,
  timer_name,
  due_at,
  firing_key,
  status,
  unique (tenant_id, instance_id, originating_revision, timer_name)
)

approval(
  tenant_id,
  approval_id,
  instance_id,
  machine_revision,
  proposed_effect_hash,
  required_authority,
  expires_at,
  decision,
  decided_by,
  decided_at
)

effect_intent(
  tenant_id,
  effect_id,
  instance_id,
  originating_revision,
  effect_name,
  effect_type,
  target,
  canonical_request_hash,
  request_payload,
  idempotency_key,
  fencing_epoch,
  delegation_id,
  policy_decision_id,
  approval_id,
  budget_reservation_id,
  authorization_fence,
  revocation_behavior,
  status,
  attempt_count,
  deadline,
  compensation_effect_id,
  unique (tenant_id, instance_id, originating_revision, effect_name)
)

effect_attempt(
  tenant_id,
  effect_id,
  attempt_number,
  started_at,
  completed_at,
  adapter_version,
  downstream_request_id,
  outcome,
  response_hash
)
```

### 6.5 Policy and receipts

```text
delegation(
  tenant_id,
  delegation_id,
  principal_id,
  issuer_id,
  allowed_operations,
  resource_scope,
  purpose,
  budgets,
  valid_time,
  revocation_state
)

policy_decision(
  tenant_id,
  decision_id,
  policy_bundle_version,
  principal_id,
  delegation_id,
  action,
  resource_scope,
  input_hash,
  outcome,
  reason_codes
)

execution_receipt(
  tenant_id,
  receipt_id,
  request_id,
  canonical_plan_hash,
  principal_id,
  delegation_id,
  catalog_version,
  snapshot_id,
  policy_decision_ids,
  evidence_manifest,
  evidence_state,
  excision_proof_ids,
  result_hash,
  effect_ids,
  budget_consumed,
  created_at
)
```

Add transactional budget reservation:

```text
budget_reservation(
  tenant_id,
  reservation_id,
  delegation_id,
  machine_instance_id,
  machine_revision,
  amount_or_units,
  budget_type,
  status,
  expires_at
)
```

The transition transaction reserves the allowed budget and binds the effect to
the exact delegation, policy, approval, and authorization fence. Dispatch
rechecks revocation and the fence. The default rule is:

- revocation committed before dispatch cancels the pending effect;
- an explicitly grandfathered effect may dispatch only when the pinned policy
  permits that behavior;
- retries use the same logical reservation and cannot exceed a separately
  enforced attempt budget.

Timer and effect IDs must be deterministic functions of their tenant, instance,
originating revision, and stable name, or the allocated IDs must be persisted as
transition inputs. Replay must never generate fresh random IDs.

## 7. Agent Intent IR

### 7.1 Read example

```json
{
  "protocol_version": "0.1",
  "request_id": "req-123",
  "principal": {
    "id": "support-agent-7",
    "delegation_id": "del-456",
    "purpose": "customer-retention-review"
  },
  "snapshot": {
    "mode": "as_of",
    "commit": "c-987",
    "projection_policy": "require_compatible_epoch",
    "fallback": "authoritative_exact_or_fail"
  },
  "budgets": {
    "max_rows": 50,
    "max_graph_depth": 2,
    "max_vector_candidates": 500,
    "max_context_tokens": 4000,
    "deadline_ms": 1500
  },
  "consistency": {
    "read": "snapshot"
  },
  "operations": [
    {
      "id": "candidate-incidents",
      "op": "semantic_candidates",
      "query": "performance degradation caused by pricing or throttling",
      "source_types": ["incident", "support_case"],
      "limit": 500
    },
    {
      "id": "related-customers",
      "op": "graph_expand",
      "input": "candidate-incidents",
      "path": ["affected", "customer"],
      "max_depth": 2
    },
    {
      "id": "eligible",
      "op": "filter",
      "input": "related-customers",
      "predicate": {
        "and": [
          {"field": "customer.region", "eq": "US"},
          {"field": "customer.arr", "gt": 100000},
          {"field": "incident.valid_time", "within": "P30D"}
        ]
      }
    },
    {
      "id": "resolved",
      "op": "resolve_assertions",
      "input": "eligible",
      "policy": "support-current-best-v3"
    }
  ],
  "expected_result": {
    "shape": "CustomerRiskSummary[]",
    "evidence": "required",
    "conflicts": "include",
    "unknowns": "explicit"
  },
  "effect_contract": {
    "classification": "read_only"
  }
}
```

### 7.2 Mutation example

```json
{
  "request_id": "reserve-789",
  "idempotency_key": "cart-22:sku-9:reservation-v1",
  "principal": {
    "id": "checkout-agent",
    "delegation_id": "checkout-policy-4"
  },
  "consistency": {
    "write": "serializable"
  },
  "operations": [
    {
      "op": "transition",
      "instance_id": "order-22",
      "event": "reserve_inventory",
      "expected_revision": 6,
      "preconditions": [
        "allocatable_quantity >= requested_quantity",
        "quote_version = active_quote_version",
        "delegation.active = true"
      ],
      "postconditions": [
        "reserved_quantity <= allocatable_quantity",
        "one active reservation for idempotency key"
      ]
    }
  ],
  "effect_contract": {
    "classification": "reversible_write",
    "max_effects": 1,
    "approval": "not_required",
    "compensation": "release_reservation"
  },
  "expected_result": {
    "shape": "ReservationReceipt",
    "evidence": "required"
  }
}
```

### 7.3 Validation rules

Before execution:

- canonicalize and hash the plan;
- resolve every schema, predicate, policy, and operation version;
- authenticate principal and delegation;
- enforce tenant and purpose scope;
- select one immutable projection epoch per projection whose declared
  source-commit interval, catalog, model, and policy scope are compatible with
  the requested snapshot;
- reject future-data leakage and either use an exact authoritative fallback or
  return a typed partial/stale result when no compatible epoch exists;
- reject unbounded fan-out, result, token, or cost;
- classify all effects;
- require approval where policy demands it;
- verify that approximate retrieval cannot directly produce a write target
  without an exact recheck;
- verify that a replay or simulation has no production effect authority.

Before dispatching a committed external effect:

- reauthenticate the dispatcher;
- recheck the bound delegation, policy decision, approval, authorization fence,
  and budget reservation;
- apply the declared revocation rule;
- reject stale fencing epochs;
- reuse the original effect and idempotency IDs;
- record `unknown` rather than retrying blindly when the downstream side may
  already have acted.

## 8. MCP surface

MCP should expose a compact boundary, not one tool per table.

### 8.1 Resources

```text
agentdb://catalog/current
agentdb://schemas/{schema_id}
agentdb://semantic-models/{version}
agentdb://policies/{visible_policy_id}
agentdb://snapshots/{snapshot_id}
agentdb://receipts/{receipt_id}
agentdb://results/{result_handle}
agentdb://machines/{instance_id}
```

### 8.2 Tools

```text
discover_capabilities
plan
validate
execute
explain
get_context_package
transition
approve
subscribe
branch_and_simulate
reconcile_effect
```

Small results return structured content. Large results return a handle and an
Arrow/Flight or signed object endpoint. Handles and URLs are tenant-bound,
short-lived, purpose-scoped, and reauthorized on dereference. The MCP server
must not embed security-critical semantics only in prose descriptions.

## 9. Human query surface

Provide SQL views and functions from the first prototype:

```text
current_records
assertions_raw
assertions_active
assertion_conflicts
resolved_values
artifact_lineage
machine_status
machine_history
pending_approvals
effect_status
execution_receipts
projection_freshness
```

Representative queries:

```sql
SELECT *
FROM assertion_conflicts
WHERE tenant_id = $1
  AND subject_entity_id = $2
  AND predicate_id = 'reported_revenue';
```

```sql
SELECT revision, transition_id, policy_decision_id, committed_tx
FROM machine_history
WHERE instance_id = $1
ORDER BY revision;
```

```sql
SELECT receipt_id, snapshot_id, evidence_manifest, effect_ids
FROM execution_receipts
WHERE request_id = $1;
```

The readable textual Agent IR should also be available in `EXPLAIN` output so a
human can compare a natural-language request, compiled plan, SQL/graph/vector
subplans, authorization decision, and expected effects.

All views run under row-level security. Administrative bypass roles are not
available to the MCP or application connection pools.

## 10. Retail vertical slices

### 10.1 Catalog conflict and publication

Inputs:

- supplier feeds;
- product descriptions and images;
- category ontology;
- existing product and variant graph.

Flow:

1. ingest source artifacts;
2. extract candidate entities and assertions;
3. retain conflicting dimensions, ingredients, compatibility, or safety data;
4. resolve duplicates with evidence;
5. require review for high-impact fields;
6. publish one catalog version;
7. retain the raw claims and resolution receipt.

Tests:

- contradictory supplier values;
- one stale source;
- entity merge followed by split;
- deletion of one supplier artifact;
- vector-near but structurally different products;
- cross-tenant catalog poisoning.

### 10.2 Inventory reservation

Invariant:

```text
confirmed + active_reserved <= allocatable
```

Flow:

1. quote at a pinned price and inventory version;
2. start or transition an order machine;
3. reserve inventory with TTL;
4. create a timer;
5. commit state, reservation, timer, and receipt atomically;
6. commit or release after payment outcome.

Tests:

- flash-sale hot key;
- concurrent agents;
- duplicate checkout request;
- timeout and late payment result;
- crash before and after commit;
- stale local/offline proposal.

### 10.3 Checkout, payment, and return

Invariants:

- no duplicate capture or refund;
- refunded amount cannot exceed captured amount;
- fulfillment and money states reconcile;
- every external effect has an effect ID and status;
- unknown payment outcomes cannot be treated as failed.

The payment simulator must support:

- idempotent request lookup;
- success;
- hard failure;
- timeout before application;
- timeout after application;
- delayed callback;
- duplicated callback.

### 10.4 Customer support and churn risk

Flow:

1. authenticate the customer scope;
2. retrieve current order/account facts;
3. retrieve support interactions and relevant policies;
4. derive a churn hypothesis with evidence;
5. return conflict, freshness, and missing-evidence status;
6. allow only policy-bounded remedies;
7. require approval above the agent's compensation limit.

Tests:

- prompt-injected support document;
- stale entitlement memory;
- another customer's semantically similar case;
- conflicting cancellation signals;
- missing current contract;
- correction propagation after the customer clarifies intent.

### 10.5 Telemetry and replenishment

Flow:

- ingest device/POS/inventory events;
- deduplicate by source event ID;
- compute event-time windows and corrections;
- maintain demand and anomaly views;
- produce replenishment recommendations as predictions;
- require transition and approval before creating a purchase order.

Tests:

- out-of-order events;
- late corrections;
- replayed device IDs;
- hot SKU partitions;
- projection lag;
- model version change.

### 10.6 Autonomous purchasing agent

Delegation includes:

```text
maximum spend
allowed categories
allowed merchants
shipping region
time window
approval threshold
return authority
revocation status
```

The agent may search and compare broadly but can only commit an effect after an
exact quote, inventory, policy, and delegation recheck.

## 11. Non-retail vertical slices

### 11.1 Incident response

- observations: logs, traces, alerts, deployments;
- hypotheses: suspected cause and confidence type;
- decisions: mitigation approved under one policy version;
- effects: command, rollback, feature flag, notification;
- state machine: detect -> triage -> approve -> mitigate -> verify -> close;
- simulation branch: replay without production effect authority.

### 11.2 Logistics dispatch

- streaming GPS and status;
- graph of depots, routes, qualifications, and jobs;
- conditional assignment transaction;
- durable accept/reject timer;
- one active assignee invariant;
- route recommendation distinct from dispatch decision.

## 12. Benchmark program

### 12.1 Substrate benchmarks

| Workload | Benchmark |
| --- | --- |
| OLTP | TPC-C plus RetailOrderBench |
| Analytics | TPC-H, TPC-DS |
| HTAP | CH-benCHmark plus concurrent retail queries |
| Key-value | YCSB A-F with tenant and hot-SKU skew |
| Graph | LDBC SNB plus retail product/lot/recall graph |
| Vector | ANN-Benchmarks plus authorized retail evidence retrieval |
| Streaming | Nexmark plus inventory, price, POS, and telemetry events |
| Workflow | Retail and incident state machines with crash injection |
| Consistency | Jepsen-style histories for reserve, assign, refund, and revoke |

Run official benchmarks unchanged for comparability. Label all adaptations
clearly; do not call an adapted workload an official TPC, LDBC, or YCSB result.

### 12.2 Agent benchmark

Use a frozen set of deterministic user/task scripts:

- catalog conflict review;
- order change and cancellation;
- policy-bounded refund;
- product comparison and purchase;
- inventory exception;
- recall investigation;
- support case with stale memory;
- incident rollback;
- logistics reassignment.

Tau-bench/tau3 retail tasks can seed task shapes, but the result checker must
validate database state and effect traces rather than text similarity.

Controls:

- same frozen model and model version;
- same decoding parameters;
- same prompt and tool descriptions;
- same data and index snapshot;
- same authority and budget;
- same task seed and failure schedule;
- model latency reported separately from system latency;
- deterministic checker, not an LLM judge, decides the headline score.

### 12.3 Memory and epistemic tests

Include LoCoMo/LongMemEval-style competencies:

- long-range retrieval;
- temporal ordering;
- fact update and correction;
- conflict resolution;
- multi-session reasoning;
- forgetting and expiry;
- provenance recovery;
- poisoned-memory resistance.

Add database-specific checks:

- no active inference without resolvable premises;
- no deleted artifact returned by ordinary retrieval;
- no old embedding version treated as current;
- no scalar confidence combined across incompatible types;
- no numeric coverage without a sampling frame.

Receipts distinguish:

```text
retained_and_reproducible
historically_justified_but_excised
```

A legally or policy-required deletion must remove protected payload,
embeddings, summaries, caches, exports, and ordinary retrieval paths. The
receipt may retain only an authorized minimal commitment and deletion proof.
Excised evidence is excluded from the ordinary resolution denominator under a
pre-registered rule; it is not counted as an unexplained missing object.

### 12.4 Per-hypothesis acceptance tests

| Hypothesis | Minimum pre-registered test |
| --- | --- |
| H1 interaction efficiency | In paired successful tasks against Baseline A1, the 95% confidence interval must show at least a 20% reduction in logical round trips and at least a 15% reduction in supplied context bytes, while total internal RPC, CPU, and planner work are reported separately |
| H2 epistemic quality | Conflict-detection precision and recall at least 95%; zero stale or unresolved assertions used for consequential effects; for claims with a calibrated probability interpretation, expected calibration error at most 0.05 and selective risk no worse than the baseline at matched coverage |
| H3 snapshot coherence | Zero future-data leakage; at least 99.9% exact-mode candidate recall against an authoritative snapshot oracle; approximate-mode recall measured separately and never accepted as write authority |
| H4 recovery | 100% state-and-trace equivalence to the oracle for every enumerated durable-boundary failure, or an explicit pre-specified quarantine outcome |
| H5 provenance | 100% of consequential effects have mandatory receipt fields; retained evidence resolves at least 99.9%; excised evidence has a valid deletion proof and is reported separately |
| H6 authorization | Zero unauthorized committed effects or cross-tenant disclosures in at least 100,000 adversarial operations covering every registered interface and worker |
| H7 operations | Meet the pre-registered workload envelope and cost gate while including projection build, compaction, recovery, observability, and model costs |

Statistical protocol:

- perform a power analysis before fixing the task count;
- use paired allocation so every system receives the same task, data snapshot,
  failure schedule, and seed;
- cluster analysis by task template and scenario rather than treating repeated
  model calls as independent;
- run at least five independent workload seeds and report confidence intervals;
- require the lower confidence bound to exceed the practical effect threshold,
  not merely zero;
- prefer a locally pinned model for reproducibility; when a hosted model is
  required, record provider revision, request/response identifiers, parameters,
  and repeated-run variance and do not describe the run as deterministic.

## 13. Instrumentation

Record every:

- Agent IR request and canonical plan hash;
- logical tool call;
- network and storage RPC;
- SQL statement and query plan;
- vector candidate count and recall;
- graph expansion count;
- policy decision;
- state transition and retry;
- effect attempt and reconciliation;
- cache hit and projection watermark;
- artifact and evidence read;
- context byte and token count;
- model call and latency;
- operator action and recovery step.

Report visible and internal calls separately. A prototype receives no credit for
moving complexity behind the endpoint without reducing total work or improving
correctness.

## 14. Failure campaign

Inject failure at every durable boundary:

1. before inbound event insert;
2. after inbox deduplication but before transition commit;
3. after state commit but before effect dispatch;
4. before remote effect application;
5. after remote effect application but before acknowledgement;
6. after acknowledgement but before local result persistence;
7. during projection update;
8. during embedding generation;
9. during object upload;
10. during timer firing;
11. during approval submission;
12. during lease renewal;
13. during policy revocation;
14. between effect authorization, lease, dispatch, and downstream application;
15. between immutable artifact upload and projection-manifest publication;
16. during branch promotion.

Also inject:

- duplicate and out-of-order events;
- process crashes and worker pauses;
- network partitions and delayed responses;
- stale projections;
- deliberately staggered projection epochs and source commits;
- clock skew;
- disk-full and object-store failures;
- malformed Agent IR;
- cross-tenant identifiers;
- expired or revoked delegation;
- every revocation-versus-dispatch interleaving under both cancel and explicitly
  grandfathered policies;
- prompt-injected artifacts;
- poisoned memory;
- budget exhaustion;
- concurrent entity merge/split;
- index rebuild while queries continue.

## 15. Required invariants

1. Revisions are gap-free and strictly increasing per machine instance.
2. One inbound `(source, event_id)` produces at most one accepted transition.
3. Every transition records a true deterministic guard under a pinned policy.
4. Replay produces the stored state hash, effect IDs, and timer IDs.
5. Every effect attempt references one committed effect intent.
6. One logical effect exists per instance/revision/effect name.
7. Stale lease epochs cannot apply effects.
8. Approval must bind the active revision, effect hash, authority, and expiry.
9. No ordinary forward effect is created after cancellation commits.
10. Compensation is itself durable, idempotent, and auditable.
11. Production effects are disabled on simulation branches.
12. Inventory, money, and assignment invariants always hold.
13. Cross-tenant reads and writes are impossible through all query paths.
14. A consequential result has a resolvable snapshot, policy, and plan, plus
    either retained evidence or an authorized deletion/excision proof.
15. A projection result cannot authorize a write without exact validation.
16. Enforced budgets cannot be exceeded through retry or fan-out.
17. A query pinned to commit `C` uses only compatible published projection
    epochs and cannot observe data committed after `C`.
18. Every dispatched effect remains authorized under its declared
    revocation/grandfathering rule, approval, authorization fence, and reserved
    budget.

## 16. Decision gates

These proposed thresholds are intentionally strict enough to falsify the
project.

Before running them, freeze a workload and deployment envelope:

```text
hardware and accelerator type
database and service topology
replication and durability acknowledgement point
data scale, tenant count, and skew
open-loop arrival rate and closed-loop concurrency
warm, cold, and mixed cache state
run duration, warm-up, and recovery interval
network region and latency
projection/index build and compaction settings
retention and backup settings
model provider/version or local model artifact
included background, observability, and recovery costs
```

| Gate | Pass condition |
| --- | --- |
| Safety | Zero confirmed invariant violations, duplicate financial effects, cross-tenant reads, or unauthorized effects in 100,000 faulted high-risk operations |
| Recovery | Every injected failure converges to the oracle state or an explicit quarantined state within five minutes |
| Provenance | 100% of committed consequential effects include principal, delegation, policy, snapshot, causal parent, and evidence state; at least 99.9% of retained references resolve, while excised references have valid deletion proofs and are reported separately |
| Epistemic quality | Meet the H2 conflict, staleness, abstention, and calibration thresholds in Section 12.4 |
| Snapshot coherence | Meet the H3 future-leakage and candidate-recall thresholds in Section 12.4 under deliberately staggered projection epochs |
| Agent success | At least 95% on benign held-out tasks and at least five percentage points above Baseline A1, with the lower 95% confidence bound exceeding the five-point practical threshold |
| Interaction efficiency | Against Baseline A1, meet the paired H1 confidence-bound reductions in Section 12.4 with no reduction in task success; report A2 separately |
| Latency | Within the frozen workload envelope: reservation p99 under 300 ms; price quote p99 under 75 ms; risk decision p99 under 200 ms; fulfillment promise p99 under 500 ms |
| Freshness | 99% of inventory and price changes visible to dependent decisions within five seconds |
| Cost | Compute, storage, network, model, projection-build, compaction, recovery, and observability cost per successful safe task no more than 1.25 times the best baseline; publish a separate pre-declared quality-adjusted Pareto frontier rather than overriding this gate |
| Operability | Fewer deployed moving parts or fewer median diagnosis/recovery steps than Baseline B, measured from pre-registered incidents |

Zero observed failures are not proof of absolute safety. With 100,000
independent trials and zero events, the approximate 95% upper bound remains
about `3 / 100000`. Correlated and adversarial failure scenarios matter more
than denominator inflation.

## 17. Implementation phases

### Phase 0: contract and oracle

Deliver:

- versioned assertion and machine semantics;
- Agent IR JSON Schema and canonicalization rules;
- delegation and effect classifications;
- 30-50 formal invariants;
- deterministic reference oracle;
- synthetic retail generator;
- pre-registered metrics, power analysis, workload envelope, and gates.

Exit criterion: independent reviewers can predict valid outcomes from the
specification without reading the implementation.

### Phase 1: transactional kernel

Deliver:

- authoritative record tables;
- assertions, artifacts, provenance, and receipts;
- serializable inventory and order operations;
- SQL views;
- read and mutation IR execution;
- exact text and vector retrieval;
- targeted transaction and crash tests.

Exit criterion: inventory and order workloads pass the safety gate without an
LLM.

### Phase 2: temporal and hybrid retrieval

Deliver:

- valid/system-time queries;
- contradiction and resolution policies;
- vector, text, graph, and predicate planning;
- immutable projection epochs and source-commit compatibility checks;
- context-package generation;
- analytical Parquet export and DuckDB runner.

Exit criterion: the system correctly handles stale, conflicting, and missing
evidence and demonstrates snapshot-coherent hybrid plans.

### Phase 3: durable machines and effects

Deliver:

- declarative state-machine definitions;
- inbox, timers, approvals, leases, outbox/effect journal;
- transactional budget reservations and dispatch-time reauthorization;
- idempotent sink simulator and reconciliation;
- revocation-versus-dispatch interleaving tests;
- branch/replay/simulation;
- complete failure campaign.

Exit criterion: all workflow recovery traces match the independent oracle.

### Phase 4: MCP and agent evaluation

Deliver:

- MCP resources and tools;
- frozen-model evaluation harness;
- deterministic task scripts and state checker;
- prompt-injection and delegation adversaries;
- round-trip, context, and token instrumentation.

Exit criterion: the prototype passes all safety gates and demonstrates or fails
H1-H6.

### Phase 5: scale, cost, and generalization

Deliver:

- official and adapted benchmark runs;
- incident-response and logistics scenarios;
- cold/warm cache tests;
- index rebuild, compaction, and retention tests;
- raw traces, configurations, seeds, and cost reports;
- a go/no-go architecture decision.

Exit criterion: publish positive and negative results. Proceed toward a custom
engine only when a measured bottleneck has no acceptable compositional fix.

## 18. Stop and pivot criteria

Stop custom-database work and reposition the result if:

- the Agent IR does not reduce total interaction or context cost;
- a PostgreSQL-centered composition matches task quality and recovery with
  lower cost;
- epistemic typing creates complexity without measurable gains under conflict
  or correction;
- graph/vector co-planning cannot outperform a clear two-stage candidate and
  exact-validation approach;
- the state-machine layer duplicates DBOS, Restate, or Temporal without a
  transactional integration advantage;
- the project cannot maintain SQL-level human auditability;
- lineage and retention costs become unacceptable without making provenance
  materially lossy.

Possible pivots:

- an open Agent Data IR standard;
- a PostgreSQL extension and reference schema;
- an MCP gateway with policy, receipts, and context optimization;
- a durable agent-state library;
- an epistemic-memory benchmark suite;
- a provenance and effect-receipt service.

## 19. Expected repository artifacts

The implementation phase should produce:

```text
/spec
  agent-ir.schema.json
  assertion-semantics.md
  state-machine-semantics.md
  result-envelope.schema.json

/kernel
  compiler
  authorization
  transactions
  assertions
  machines
  effects
  receipts

/mcp
  server
  resources
  tools

/bench
  retail-generator
  oracle
  substrate
  agent-tasks
  fault-injection
  reports

/deploy
  local
  object-store
  observability
```

Every benchmark report should include source revision, dependency versions,
hardware, operating system, configuration, seeds, cache state, failures,
confidence intervals, and raw result locations.

## 20. Immediate next engineering decision

The first implementation decision should be whether to build:

1. a service over PostgreSQL, recommended for fastest falsification; or
2. a PostgreSQL extension, appropriate only if planner/index integration is
   already the measured research target.

The service approach is recommended. It preserves the option to replace the
kernel later while allowing the team to validate the semantics, Agent IR,
state-machine coupling, and benchmark methodology first.

## Key benchmark sources

- TPC-C: <https://www.tpc.org/tpc_documents_current_versions/pdf/tpc-c_v5.11.0.pdf>
- TPC-H: <https://www.tpc.org/tpc_documents_current_versions/pdf/tpc-h_v3.0.1.pdf>
- TPC-DS: <https://www.tpc.org/tpcds/>
- CH-benCHmark:
  <https://wwwdb.inf.tu-dresden.de/research-projects/CH-BenCHmark/CH-benCHmark.pdf>
- YCSB: <https://github.com/brianfrankcooper/YCSB>
- LDBC SNB: <https://ldbcouncil.org/benchmarks/snb/>
- ANN-Benchmarks: <https://ann-benchmarks.com/>
- Apache Beam Nexmark:
  <https://beam.apache.org/documentation/sdks/java/testing/nexmark/>
- Jepsen: <https://github.com/jepsen-io/jepsen>
- Tau3-bench: <https://github.com/sierra-research/tau2-bench>
- LoCoMo: <https://aclanthology.org/2024.acl-long.747/>
- LongMemEval: <https://arxiv.org/abs/2410.10813>
- W3C PROV-DM: <https://www.w3.org/TR/prov-dm/>
