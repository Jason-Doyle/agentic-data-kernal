# Agent-First Data Systems

## Research findings and reference architecture

Research snapshot: 2026-09-01

Status: Research baseline for review, not a product specification

## Executive conclusion

The thesis is directionally correct, but it needs one important correction:
traditional databases were not primarily designed "for humans." Their query
languages and administration workflows often assume human experts, but their
transaction, indexing, recovery, replication, and execution machinery has
always served programs.

The more precise mismatch is this:

> Existing databases assume that deterministic application code sits between
> ambiguous human intent and authoritative data. Autonomous agents collapse
> intent interpretation, planning, retrieval, inference, memory, and external
> action into one loop. The missing layer is therefore not another storage
> shape. It is a machine-verifiable contract for knowledge, authority, state,
> evidence, uncertainty, and effects.

The recommended design is an **agent-first data system**, not a universal
replacement storage engine. Its logical kernel should combine:

1. **Authoritative records** for money, inventory, identity, permissions, and
   other invariant-bearing state.
2. **Typed assertions** for observations, reported facts, inferences,
   predictions, hypotheses, and conflicting evidence.
3. **Bitemporal history** separating when something was valid in the world from
   when the system recorded or believed it.
4. **First-class provenance** linking every consequential derivation and action
   to its sources, rules, model, policy, and snapshot.
5. **Durable state machines** whose transitions, approvals, timers, and effect
   intents commit with related data changes.
6. **Version-coherent projections** for relational, graph, vector, text,
   streaming, and analytical access.
7. **A typed agent intent/effect protocol** that states result shape, budgets,
   consistency, authority, evidence requirements, and allowed side effects.
8. **Standard human interfaces**, especially SQL, with graph and semantic
   projections where useful.
9. **Hot-memory, warm-local, and cold-object storage tiers** with explicit
   snapshot identity and rebuildable indexes.
10. **A falsifiable benchmark program** measuring task correctness, safety,
    recovery, provenance, tool round trips, context consumption, latency,
    throughput, freshness, and cost.

The supplied "persistent world model" concept is a strong synthesis. However,
its individual ideas have substantial prior art: RDF and RDF-star,
nanopublications, Wikidata statements, Datomic datoms, bitemporal databases,
probabilistic databases, truth-maintenance systems, provenance semirings,
property graphs, data cubes, and temporal knowledge graphs all cover important
parts of it.[1-15] The genuine research opportunity is the integrated algebra
and execution contract, not the seven-field claim tuple by itself.

## 1. Research framing

### 1.1 Questions

This research examined:

- What data abstractions are natural for autonomous agents?
- Which existing database mechanisms should be reused rather than reinvented?
- How should transactional, analytical, streaming, retrieval, and state-machine
  workloads coexist?
- How should uncertainty, contradiction, time, provenance, and incomplete
  knowledge be represented?
- What should agents query that differs from what people query?
- What belongs in MCP, and what requires a lower-level database protocol?
- How should memory, local storage, and cloud/object storage be divided?
- How can a proof of concept demonstrate an advantage rather than merely hide
  several familiar components behind one API?

### 1.2 Evidence standard

Primary sources were preferred:

- standards and specifications;
- peer-reviewed papers and technical reports;
- official project documentation and source repositories;
- official benchmark specifications.

Vendor benchmarks and product claims are identified as such. Public issue
reports are useful examples of failure mechanisms, not estimates of product-wide
failure rates. The supplied concept note and the companion MarkupBase paper
*When Memory Becomes Production State* were treated as hypotheses and design
inputs, not as independent evidence.

### 1.3 Two engineering lenses

| Data and analytics engineering lens | LLM and agent lens |
| --- | --- |
| Correctness, isolation, recovery, durability, and cost | Ambiguous intent, incomplete knowledge, and uncertainty |
| Stable schemas, data contracts, lineage, and governance | Semantic discovery and context-window constraints |
| Workload-specific physical layouts | Fewer tool calls and bounded result shapes |
| Reproducible snapshots and incremental views | Evidence packages, abstention, and explanations |
| Security boundaries and operational observability | Delegated authority and safe external effects |
| Human-debuggable query plans | Machine-verifiable plans and receipts |

An agent-first system must satisfy both columns. Optimizing only for the right
column creates an unreliable memory product. Optimizing only for the left
column recreates an ordinary database with an LLM wrapper.

## 2. The refined thesis

### 2.1 What is actually missing

SQL syntax is not the central problem. Modern databases already expose binary
protocols, prepared statements, embedded libraries, vectorized execution, and
machine-readable catalogs. PostgreSQL supplies serializable transactions;
FoundationDB supplies a strongly transactional ordered key-value substrate;
Arrow supplies a language-neutral columnar memory format; Substrait supplies an
interoperable representation of structured compute plans.[16-20]

The missing capabilities are:

- an explicit distinction between observation, inference, decision, directive,
  and authoritative state;
- temporal and evidential context carried through every operation;
- safe handling of contradiction and unknowns;
- transactional coupling between data state, workflow state, and effect intent;
- query contracts optimized for bounded machine consumption;
- purpose- and capability-scoped delegated authorization;
- deterministic receipts explaining what snapshot, evidence, policy, and plan
  produced an answer or effect;
- lifecycle operations such as revision, supersession, forgetting, correction,
  and branch/replay.

Recent 2026 research independently reaches a similar conclusion. Governed
Evolving Memory argues that long-term agent memory is a data-management workload
whose correctness belongs to the trajectory of memory state, not only to
individual records.[21] A separate study of 12 memory systems finds that no
single architecture dominates and decomposes the workload into representation,
extraction, retrieval/routing, and maintenance.[22] Oracle's 2026 technical
report similarly frames agent memory as a lifecycle and database systems
problem, although its implementation is still alpha.[23]

### 2.2 "Agent first" must not mean "human authority second"

The phrase should describe interface and execution optimization, not governance.
Humans still need:

- readable plans and queries;
- explicit approval for high-consequence effects;
- correction and deletion controls;
- understandable conflicts and uncertainty;
- complete audit and recovery paths;
- the ability to query the same state through SQL or another standardized
  language.

The machine path may be primary for volume and speed. Human authority,
inspectability, and override remain first-class safety requirements.

## 3. Assessment of the supplied persistent-world-model concept

The concept note proposed a sparse, temporal, semantic knowledge space whose
basic atom resembles:

```text
(subject, relation, object, context, time, source, confidence)
```

The intuition is valuable. The implementation needs the following refinements.

| Concept-note idea | Research judgment | Required refinement |
| --- | --- | --- |
| Claim as the primary atom | Strong for an epistemic layer, not novel by itself | Keep authoritative operational records separate from claims |
| Relationships are first-class | Correct | Support n-ary relations and named roles, not only subject-predicate-object triples |
| Time is intrinsic | Essential | Use valid time and system time; distinguish world change from belief correction |
| Contradictions coexist | Essential for reported knowledge | Do not allow contradictions to bypass transactional invariants |
| Every derivation has lineage | Essential but potentially expensive | Use shared/factorized provenance, retention, and explicit lossy boundaries |
| Every object has confidence | Too simple | Use a tagged uncertainty type; separate probability, source trust, extraction score, and editorial rank |
| Every object has an embedding | Useful as a projection, not as truth | Version embeddings by model and snapshot; build only where useful |
| Hybrid graph/vector/filter/time query | High-value synthesis | Retrieve candidates first, then apply exact authorization, temporal, and integrity checks |
| Dynamic dimensions | Useful only under governance | Permit namespaced facets, but register typed/indexed dimensions in a versioned catalog |
| Infinite sparse tensor | Helpful conceptual analogy | Do not force the physical engine into one tensor representation |
| Database knows what it does not know | Critical | Return typed epistemic status; numeric coverage is valid only when the expected universe is defined |
| Natural or SQL-like agent language | Useful for authoring | Compile to a canonical typed IR before authorization or execution |

### 3.1 The claim tuple is established prior art

The tuple closely resembles:

- nanopublications: assertion, provenance, and publication information;[1]
- micropublications: claims, evidence, and argument links;[2]
- Wikidata statements: values, qualifiers, references, and ranks;[3]
- RDF-star triple terms and named graphs;[4]
- Datomic's universal datom relation;[5]
- probabilistic databases combining uncertainty and lineage;[8]
- Graphiti temporal facts with embeddings and episode provenance.[24]

This does not weaken the idea. Repeated reinvention is evidence that the
abstraction is useful. It does mean the project should claim novelty only for
the parts that are genuinely integrated or formally new.

### 3.2 A graph is not enough

A pure triple model is weaker than many real business relationships. A retail
purchase naturally has buyer, seller, item, quantity, price, currency, channel,
promotion, and effective time. Encoding that as many binary edges introduces
reification complexity and can lose role semantics. GQL, SQL/PGQ, TypeDB, and
the W3C's n-ary relation patterns demonstrate established alternatives.[25-27]

The logical model should therefore support both:

```text
AtomicFact(subject, attribute, value)
```

and:

```text
Relation(type, { role_name -> entity_or_value })
```

Relationships can still be projected as graph edges for traversal.

### 3.3 Confidence cannot be one float

The value `0.74` might mean:

- probability that a proposition is true;
- model classification confidence;
- retrieval similarity;
- extraction/parser confidence;
- source reliability;
- an ordinal rank;
- a human review score.

These values are not interchangeable. Similarity is especially dangerous:
cosine similarity is a retrieval score, not evidence that a proposition is
true. Correlated claims also cannot be combined as if independent. Trio's
uncertainty-and-lineage model and probabilistic-database results show why
ancestry matters and why exact probability computation can become
intractable.[8-10]

Use a tagged type:

```text
Strength =
    None
  | Rank(preferred | normal | deprecated)
  | Probability(value, calibration_ref, event_definition)
  | Opinion(belief, disbelief, uncertainty, base_rate)
  | Interval(low, high, method)
  | EvidenceCount(supporting, considered)
```

Combination is permitted only under a declared calculus and compatible
lineage. Retrieval scores remain separate.

### 3.4 Contradiction is not the same as invalid state

These can coexist:

```text
Supplier A reports product weight = 4.8 kg
Supplier B reports product weight = 5.1 kg
```

These cannot both be committed as valid authoritative state:

```text
inventory reserved = 11
inventory allocatable = 10
```

The first is epistemic conflict. The second violates an invariant. Belnap's
four-valued logic and consistent-query-answer research provide models for
querying inconsistent knowledge without logical explosion.[12-13] Serializable
transactions and constraints remain responsible for authoritative state.

### 3.5 "Unknown" needs a type system

Zero rows can mean:

- known false;
- not observed;
- outside source coverage;
- stale evidence;
- conflicting evidence;
- not applicable;
- inaccessible due to policy;
- projection not yet refreshed.

The result contract should distinguish these where authorization permits.
Security may require collapsing "hidden record exists" and "record does not
exist" into one response to prevent existence leaks.

Numeric coverage such as `62%` is legitimate only when the expected source set
or population is known. Otherwise the honest value is `coverage: unknown`.

## 4. Existing systems and the unoccupied design space

### 4.1 What mature systems already solve

| Capability | Established sources |
| --- | --- |
| ACID, MVCC, serializability, recovery | PostgreSQL, FoundationDB, Spanner, CockroachDB |
| Embedded/local analytics | DuckDB |
| Columnar interchange and execution plans | Arrow, Arrow Flight/ADBC, Substrait |
| Immutable object-store snapshots | Iceberg, Delta Lake, Hudi, Lance |
| Ordered event history | Kafka, Redpanda |
| Incremental materialized views | Materialize, DBSP |
| Property-graph traversal | Neo4j, GQL, SQL/PGQ |
| Exact and approximate vector retrieval | pgvector, Qdrant, LanceDB and others |
| Bitemporal data | SQL:2011, XTDB |
| Immutable fact history | Datomic |
| Durable execution | Temporal, Restate, DBOS, Durable Functions |
| Agent/tool connectivity | MCP |

The project should reuse these mechanisms until measurement proves they are the
bottleneck.

### 4.2 Current agent-memory landscape

| System | Verified strength | Important limitation |
| --- | --- | --- |
| Letta MemFS | Inspectable local/cloud Markdown memory with Git history | No vector index by default, no database transaction/query semantics |
| Mem0 | Scoped extraction and retrieval, active benchmark work | No documented transaction model; open-source and managed capabilities differ |
| Graphiti | Temporal context graph, hybrid retrieval, episode provenance, MCP | Atomicity depends on backend; no durable workflow/effect semantics |
| Neo4j Agent Memory | Short-, long-, and reasoning-memory taxonomy; Cypher, audit edges, eval harness | Experimental Neo4j Labs project |
| LangGraph | Durable checkpoints, replay/fork, separate long-term store | Checkpoint and memory stores remain distinct; retention is adapter/application work |
| Redis Agent Memory | Session and long-term tiers, TTL, hybrid retrieval, sensitive-data exclusions | Supported path is managed; no graph, bitemporal provenance, or workflow transaction |
| Oracle Agent Memory | Database-native threads, hybrid search, scope, context cards | Alpha; no bitemporal graph or MCP found |
| XTDB | Automatic bitemporal SQL and immutable history | No vector, graph-memory, workflow, or MCP layer |
| Datomic | Immutable datoms, as-of queries, Datalog | One primary time axis; no modern retrieval or agent layer |
| Lance | ACID snapshots, branches, object-store multimodal and hybrid indexes | Storage substrate, not an agent-memory model |
| DBOS / Restate / Temporal | Durable execution and recovery | Not epistemic memory/query systems |
| CozoDB | Datalog, graph/relational querying, vector/FTS, time travel in an embedded engine | Does not supply the full bitemporal, governance, transaction/effect contract proposed here |

Sources include current project documentation, source repositories, and
papers.[21-24][28-39]

### 4.3 What no verified system combines

No verified system found in this review combines all of:

1. authoritative serializable transactions;
2. bitemporal claims and explicit contradiction;
3. vector, text, graph, and relational access at one logical snapshot;
4. fact-level provenance and typed uncertainty;
5. durable state machines and external effect intents in the same commit;
6. policy-driven revision, forgetting, and deletion;
7. a human query language;
8. a machine-native intent/effect contract;
9. local/embedded and cloud/object-store deployment;
10. benchmarkable context and tool-call efficiency.

That intersection is the project's credible design space.

## 5. Proposed reference architecture

The recommended architecture is one authority with many versioned projections.

```text
 Human tools                                      Agent runtimes
 SQL / GQL / UI / notebooks                MCP / SDK / typed Agent IR
       |                                               |
       +-------------------+---------------------------+
                           |
                 Catalog, compiler, policy gate
                           |
          +----------------+------------------+
          | Epistemic transaction kernel      |
          |                                    |
          | authoritative records              |
          | assertions and evidence            |
          | machine instances and transitions  |
          | effect intents and approvals        |
          | policy and execution receipts       |
          +----------------+-------------------+
                           |
                  Commit/version manifest
                           |
       +-------------------+--------------------+
       |                   |                    |
   row/KV view       graph/vector/text     columnar/stream
   and indexes          projections          projections
       |                   |                    |
       +-------------------+--------------------+
                           |
             hot RAM -> warm NVMe -> cold objects
```

### 5.1 Authority plane

Stores invariant-bearing state:

- customers and authenticated identities;
- inventory and reservations;
- orders, payments, returns, and ledgers;
- permissions, delegations, and policy versions;
- machine-instance revisions;
- effect intents and idempotency keys.

Use serializable transactions or an equivalent conflict-validation model for
shared decisions. Lower consistency is allowed only when explicitly requested
for exploratory or stale-tolerant reads.

### 5.2 Epistemic plane

Stores what was observed, reported, inferred, predicted, decided, or disputed.
It preserves alternatives rather than forcing premature canonicalization.

### 5.3 State and effect plane

Stores durable state-machine definitions and instances, inbox deduplication,
timers, approvals, leases, effect intents, attempts, results, and
compensations. A transition can atomically update authoritative state, append
assertions, and create an effect intent.

### 5.4 Projection plane

All retrieval-specific structures are derived and rebuildable:

- B-tree/ordered indexes;
- inverted text indexes;
- graph adjacency;
- ANN vector indexes;
- materialized and incremental views;
- columnar analytical fragments;
- stream topics/change feeds;
- context-package caches.

Every projection records:

```text
source_commit
source_snapshot
freshness_watermark
index_model_or_schema_version
policy_scope
rebuild_method
```

For snapshot-sensitive queries, a watermark is not enough. Each projection must
publish an immutable **projection epoch**:

```text
projection_epoch_id
source_commit_interval
catalog_and_model_version
immutable_manifest
completeness_mode
published_at
retired_at
```

A query pinned to commit `C` may use only an epoch whose declared source range
and semantics are compatible with `C`. If no compatible epoch exists, the
engine must either fall back to an exact authoritative path or return a
formally typed stale/partial result. It must not silently combine a current ANN
index, an older graph projection, and a different analytical snapshot.

An approximate or stale projection may generate candidates. It may not
independently authorize a consequential write.

## 6. Minimal logical model

Do not force every byte into a giant graph. Use explicit kernel types.

### 6.1 Core objects

```text
Entity
  Stable logical identity with versioned aliases, merges, and splits.

Record
  Authoritative typed operational state with constraints.

Assertion
  A temporal, scoped statement about an atomic or n-ary fact.

Artifact
  Immutable source material: document, image, audio, event, model output,
  external response, or binary object.

Derivation
  A versioned rule, query, model, or transformation linking inputs to outputs.

Policy
  Authorization, purpose, retention, approval, and effect constraints.

Machine
  Durable workflow/state-machine definition and instance.

Effect
  Planned or attempted interaction with an external system.

Receipt
  Immutable record of plan, snapshot, policy decision, evidence, and outcome.
```

### 6.2 Assertion type

```text
Assertion {
  assertion_id
  tenant_and_scope
  act: assert | retract | deprecate | supersede(assertion_id)
  fact:
      atomic(subject, attribute, typed_value)
    | relation(type, role_bindings)
  kind:
      observation | reported_fact | inference | prediction
    | hypothesis | decision | directive | experience
  perspective:
      agent | user | team | organization | scenario
  valid_time: [from, to)
  system_time: [recorded, superseded)
  basis:
      source_refs | derivation(rule_or_model, input_assertions)
  strength: tagged_uncertainty
  authority_class
  sensitivity_and_retention
  status:
      proposed | active | disputed | superseded
    | expired | quarantined | deleted_or_excised
  schema_version
}
```

### 6.3 Important semantic distinctions

**Observation vs inference**

An observation records that a sensor or person produced a value. It remains a
historical event even if later judged wrong. An inference is recomputable and
may be retracted when its premises or model change.

**Decision vs fact**

A decision is an immutable record that an authority chose an action under a
particular policy and evidence set. Later reversal supersedes the decision; it
does not rewrite history.

**World update vs belief revision**

If a customer moves, valid time changes because the world changed. If a source
was wrong about the customer's location, system-time history changes because
the system's belief was revised. Belief-revision research makes this
distinction explicit; bitemporal columns alone do not decide the semantics.[11]

**Perspective**

Two agents may hold different beliefs without corrupting the authoritative
record. Cross-perspective disagreement is queryable. A perspective does not
grant authority.

### 6.4 Resolved belief views

Applications often need one operational answer. A `ResolvedValue` is a derived
object, not a destructive overwrite:

```text
ResolvedValue {
  subject_and_attribute
  selected_value
  candidate_assertions
  conflicting_assertions
  resolution_policy_and_version
  valid_and_system_time
  strength
  explanation
}
```

Resolution policies can prioritize an authoritative source, reconcile
compatible intervals, require quorum, preserve a range, or abstain.

### 6.5 Provenance

W3C PROV supplies a useful interoperable vocabulary for entities, activities,
agents, derivations, and provenance bundles.[7] Provenance semirings provide an
algebra for alternative and joint derivations, but aggregates, negation, and
large derivation spaces require care.[6]

Practical controls:

- share common derivation subgraphs;
- store Merkle roots and compact manifests for large evidence sets;
- preserve exact lineage for consequential actions;
- allow declared lossy lineage for low-risk analytics;
- record when an aggregate or model breaks exact tuple-level traceability;
- propagate deletion and sensitivity through derived artifacts.

## 7. Agent-native querying and manipulation

### 7.1 Natural language is an intent-acquisition layer

Natural language should propose a plan, not execute directly:

```text
natural-language request
  -> schema and capability discovery
  -> typed plan proposal
  -> semantic, authorization, cost, and effect validation
  -> preview or approval when required
  -> execution
  -> typed result and receipt
```

Constrained structured output can improve syntax validity, but it cannot prove
semantic correctness, authorization, or safe effects. Text-to-SQL benchmarks
also show that execution success remains materially below semantic certainty in
realistic settings.[40-41]

### 7.2 Canonical Agent Intent IR

The core protocol should accept a versioned, canonical intermediate
representation. JSON, CBOR, or Protobuf can serialize it; the semantics must be
independent of encoding.

```text
IntentEnvelope {
  protocol_version
  request_id
  idempotency_key
  principal_and_delegation
  semantic_catalog_snapshot
  data_snapshot
  authorization_intent
  consistency_and_transaction_mode
  budgets
  operation_dag
  expected_result
  evidence_requirements
  effect_contract
  replay_requirements
}
```

The operation DAG should include:

- scan, filter, join, aggregate, window;
- graph match, expand, path, reachability;
- text, vector, and hybrid candidate retrieval;
- temporal `as_of`, `valid_during`, and `changed_since`;
- assertion `raw`, `resolve`, `conflicts`, and `support`;
- rule evaluation and incremental views;
- subscribe and change stream;
- state transition, approval, branch, and simulation;
- mutation with preconditions and postconditions.

### 7.3 Query execution order

For hybrid retrieval:

1. authenticate principal and bind scope;
2. choose a pinned authoritative snapshot and compatible immutable projection
   epochs;
3. retrieve candidates through those text/vector/graph epochs, or explicitly
   downgrade the result to partial/stale;
4. apply exact authorization and tenant filters;
5. apply temporal and structural constraints;
6. validate candidate versions against authoritative state;
7. resolve or expose conflicting assertions;
8. rank with separate relevance, freshness, and evidence components;
9. shape the bounded result;
10. produce provenance and policy receipts.

Do not blindly multiply `similarity * confidence * recency`. Those quantities
have different meanings and may not be calibrated to one scale.

### 7.4 Result envelope

```text
ResultEnvelope<T> {
  status:
      complete | partial | unknown | conflicted
    | stale | denied | failed
  data: T
  snapshot_id
  semantic_and_policy_versions
  epistemic_status
  evidence_and_lineage
  conflicts
  strength
  retrieval_scores
  coverage:
      measured(value, sampling_frame)
    | bounded(lower, upper, method)
    | unknown
  projection_freshness
  omissions_and_redactions
  budget_consumed
  receipt_id
}
```

### 7.5 Human interfaces

Retain:

- SQL for transactions, analytics, administration, and broad ecosystem
  compatibility;
- GQL, SQL/PGQ, Cypher-compatible, or SPARQL projections where graph semantics
  are required;
- REST/OpenAPI or GraphQL for applications;
- Arrow Flight/ADBC for efficient typed bulk transfer;
- a readable textual form of the Agent IR for debugging.

All interfaces compile through the same policy, snapshot, provenance, and
effect path.

### 7.6 MCP's role

The current MCP specification provides JSON-RPC, resources, prompts, tools,
capability negotiation, progress, cancellation, elicitation, and optional
extensions such as durable task handles.[42] It explicitly cannot enforce all
security principles at the protocol level.

Use MCP as an edge adapter:

- resources for catalog, semantic models, schemas, policies, and result handles;
- tools for `plan`, `validate`, `execute`, `explain`, `transition`,
  `approve`, `subscribe`, and `context_package`;
- durable task handles for long-running analytics or workflows;
- bounded structured results and links to bulk data.

Keep these in the core engine protocol:

- transaction and isolation semantics;
- canonical Agent IR;
- authorization and policy binding;
- idempotency and effect contracts;
- snapshot/version rules;
- provenance algebra;
- high-volume Arrow or binary data transport.

MCP is the ecosystem connector, not the database kernel.

## 8. Transactional, non-transactional, and state-machine semantics

### 8.1 Transactional workloads

Use strong transactions for:

- inventory allocation;
- financial ledgers;
- identity and permission changes;
- policy and delegation changes;
- state-machine transitions;
- effect-intent creation;
- approval consumption;
- uniqueness and capacity constraints.

The commit receipt should bind:

```text
transaction_id
principal_and_delegation
policy_version
read_snapshot
conflict_or_predicate_footprint
mutations
assertions_and_evidence_hashes
machine_transition
effect_intents
projection_update_status
commit_sequence
```

### 8.2 Analytical and retrieval workloads

Use snapshot or bounded-staleness reads for:

- historical analysis;
- forecasting and feature generation;
- hybrid retrieval;
- exploratory graph analysis;
- model training;
- corpus-wide summaries.

Columnar and object-store formats should carry the source commit and semantic
model version. Analysts and agents must be able to reproduce an `as_of` result.
Snapshot coherence requires immutable manifests mapped to source-commit
intervals; a freshness timestamp alone does not prevent future-data leakage or
omission of data that existed at the requested snapshot.

### 8.3 Streaming and incremental workloads

Append logs and incremental views are appropriate for:

- telemetry;
- inventory changes;
- price and catalog updates;
- fraud features;
- workflow events;
- alerting.

Event time, ingestion time, correction time, watermark, and deduplication key
must be explicit. Materialized views need retention and compaction contracts.

### 8.4 First-class durable state machines

Each long-lived agent task or business process should be a database object:

```text
MachineDefinition {
  type
  semantic_version
  states_and_parallel_regions
  events
  deterministic_guards
  transition_priority
  effect_schemas
  policies
  compensation_rules
}

MachineInstance {
  instance_id
  pinned_definition
  active_state
  state_data
  revision
  deadline
  lease_epoch
  branch_parent
}
```

A transition is one transaction:

```text
deduplicate inbound event
check expected revision
evaluate deterministic guard
append event and decision
update state
create or cancel timers
create approval records
create effect intents
commit
```

An LLM judgment, random value, external API call, or wall-clock read is not a
guard. It becomes a recorded input or effect result consumed by a later
deterministic transition.

### 8.5 Honest exactly-once semantics

The system can guarantee:

- exactly-once inbound-event acceptance by deduplication key;
- exactly-once logical effect intent for a committed transition;
- at-least-once delivery attempts;
- at-most-once downstream application only when the receiver durably
  deduplicates the same effect ID;
- effectively-once behavior when idempotency and reconciliation are available.

No database can prove that an arbitrary remote tool executed exactly once if
the remote system acted and the acknowledgement was lost. Temporal, Restate,
DBOS, Kafka, FoundationDB, and actor-system documentation all reinforce this
boundary.[32-36][43]

## 9. Physical storage and execution

### 9.1 Recommended tiers

**Hot memory**

- current catalog and policy snapshots;
- active machine instances and conflict metadata;
- hot B-tree/vector/graph pages;
- bounded query/result cache;
- active incremental arrangements;
- context-package cache.

**Warm local NVMe**

- WAL or replicated log;
- recent row/KV state;
- recent event segments;
- local columnar fragments;
- graph/text/vector indexes;
- spill and compaction workspace.

**Cold local or cloud object storage**

- immutable source artifacts;
- historical checkpoints and log segments;
- Parquet/Lance analytical data;
- old index versions;
- model and semantic snapshots;
- backup and recovery manifests.

Each object records:

```text
content_id
logical_version
tenant_and_encryption_domain
retention_class
source_commit
location_and_cache_status
```

### 9.2 One logical commit, specialized physical forms

Do not seek one representation that is simultaneously the optimal row store,
graph engine, ANN index, stream log, and analytical format. The transaction
kernel commits the authority and projection intents. Specialized projections
may update synchronously or asynchronously, but their freshness is explicit.

The authority sequence is:

1. commit authoritative state, state-machine change, effect intents, and an
   outbox/log position;
2. build immutable projection or object artifacts for a declared source range;
3. verify their checksums and completeness mode;
4. atomically publish a projection manifest/epoch in the transaction kernel;
5. expose that epoch to queries;
6. quarantine or rebuild any partially published artifact without advancing the
   visible manifest.

This prevents a database commit from appearing to have an analytical, vector,
graph, or object projection that was never durably published.

### 9.3 Local and offline operation

Local-first agents may:

- read cached, snapshot-identified state;
- append observations and draft assertions;
- perform private analysis and simulation;
- prepare signed mutation proposals.

They may not claim globally valid inventory, financial, permission, or other
invariant-bearing writes while disconnected. Those proposals must validate
against the authority on synchronization. CRDTs are appropriate only for
operations proven mergeable; invariant-confluence research provides the right
test.[14-15]

### 9.4 Context is an execution resource

The optimizer should treat token/context bytes as a first-class budget alongside
latency, rows, memory, and money. A `ContextPackage` can contain:

```text
selected records and evidence snippets
semantic definitions
source trust and freshness
conflicts and unknowns
token and byte estimates
reason for inclusion
expiration
stable source identifiers
```

The database selects evidence; it does not promote untrusted content into
instructions.

## 10. Security, governance, and lifecycle

### 10.1 Core controls

- enforce tenant, user, agent, purpose, field, and data-class scope in the
  engine;
- bind delegated authority to operation, target, budget, and expiry;
- treat retrieved content and tool descriptions as untrusted data;
- require previews and approvals for irreversible, high-value, cross-boundary,
  or broad effects;
- preserve canonical plan, policy, catalog, model, and evidence versions;
- record which memories/assertions were supplied for consequential actions;
- use per-principal resource budgets to prevent accidental or adversarial
  scans, embeddings, and fan-out;
- separate proposed procedural memory from approved active policy.

MCP and OWASP guidance both emphasize consent, least privilege, and
prompt-injection risk.[42][44] AgentPoison demonstrates that poisoned memory can
remain dormant and influence later agent behavior.[45]

### 10.2 Memory lifecycle

The companion memory research identifies a useful lifecycle:

```text
capture -> validate -> classify -> persist -> consolidate -> retrieve
-> apply -> correct -> expire -> delete -> audit/recover
```

Every stage needs an observable success or failure. A successful extraction is
not a durable write. A relevant retrieval is not an authoritative fact. A
delete from one table is not proof that embeddings, summaries, caches, logs,
and downstream artifacts were removed.

### 10.3 Immutability and deletion

Append-only history conflicts with privacy and retention obligations. The system
needs:

- explicit retention and legal-hold policy;
- source indirection and per-object encryption keys where appropriate;
- deletion propagation to projections and derived artifacts;
- excision markers explaining that historical reconstruction is no longer
  complete;
- protected audit metadata that does not unnecessarily duplicate deleted
  content.

Receipts therefore need two valid evidence states:

- `retained_and_reproducible`, where authorized evidence still resolves; and
- `historically_justified_but_excised`, where a minimal commitment, deletion
  proof, and policy record remain but the protected payload is intentionally no
  longer reconstructible.

A compliant deletion must not be reported as a provenance failure.

## 11. Representative use cases

### 11.1 Retail

| Scenario | Primary workload | Why agent-first semantics matter |
| --- | --- | --- |
| Catalog and entity resolution | Claims, graph, retrieval, review | Conflicting supplier facts, source lineage, effective dates, reversible merges |
| Inventory reservation | Serializable OLTP, timers | No oversell, expiring holds, idempotent release, exact policy snapshot |
| Pricing and promotions | Temporal rules, high-rate reads | One coherent rules version and explanation of applied/excluded promotions |
| Checkout, payment, and returns | Transaction plus durable saga | No duplicate charge/refund, unknown external outcome, compensation |
| Customer support | Hybrid retrieval and bounded effects | Evidence-linked answers, customer isolation, remedy limits |
| Fraud and risk | Streaming features and approval state | Model/policy versions, reason codes, review gates |
| Recommendations | Vector/graph retrieval plus hard filters | Similarity cannot bypass stock, consent, age, or policy constraints |
| Demand and replenishment | Analytics plus workflow | Forecast is distinct from approved purchase order |
| Store/IoT telemetry | Streaming and temporal correction | Late events, device provenance, corroborated alerts |
| Omnichannel fulfillment | Distributed transactions/state machines | One unit cannot be promised to two completed orders |
| Autonomous purchasing | Delegation and effect contracts | Spend, merchant, category, time, and revocation constraints |
| Recall and reverse logistics | Graph, temporal, monotonic safety state | Lot provenance, complete affected-item search, durable remediation |

### 11.2 Non-retail generalization

**Incident response**

An agent correlates logs, traces, deployments, incidents, and runbooks. It may
propose or perform a rollback only under scoped authority. The database must
preserve the evidence timeline, distinguish hypothesis from confirmed cause,
record every command effect, and support branch simulation.

**Logistics dispatch**

An agent assigns jobs under capacity, qualification, location, and time-window
constraints. It needs streaming location data, conditional assignment,
idempotent acceptance, durable exceptions, and an explanation of why a route or
driver was chosen.

**Scientific or industrial operations**

Sensors produce observations; models produce predictions; engineers approve
maintenance actions. The system must keep those kinds distinct and preserve
calibration, model, and evidence lineage.

## 12. Credible novelty and research agenda

### 12.1 Likely not novel

- a claim with context, time, source, and confidence;
- graph edges with properties;
- bitemporal records;
- vector plus predicate filtering;
- immutable facts and as-of queries;
- provenance graphs;
- workflow replay;
- multidimensional sparse representations.

### 12.2 Potentially novel

**Product annotation algebra**

A closed algebra over:

```text
provenance x typed uncertainty x valid/system time x perspective
```

while keeping similarity as a candidate-retrieval score rather than falsely
turning it into truth confidence.

**Epistemic kinds with enforced revision laws**

Observation, inference, prediction, decision, and directive have different
mutation, recomputation, approval, and retention semantics.

**Epistemic transactional commit**

One commit binds authoritative mutations, assertions, provenance, a state
transition, policy decision, and effect intents.

**Perspective-indexed belief state**

The system can query one agent's, one team's, or one scenario's beliefs without
confusing them with authoritative truth.

**Default answer contract**

Evidence, conflicts, time basis, strength type, snapshot, and policy are normal
return values rather than optional observability metadata.

**Context-aware optimizer**

The optimizer minimizes not only compute and I/O but also tool round trips,
context bytes, token cost, stale evidence, and authorization exposure.

### 12.3 Hard research problems

1. How should provenance, temporal intervals, uncertainty, and rule derivation
   compose without exponential lineage growth?
2. How can similarity participate in planning without being mistaken for
   probability or evidence?
3. What is the minimal Agent IR that remains expressive without becoming a
   lowest-common-denominator query language?
4. How should policy apply to inferred facts whose sources have different
   sensitivity?
5. How can deletion preserve enough audit shape while removing sensitive
   payload and contaminated derivations?
6. Which local/offline operations are safely mergeable?
7. How should perspective inheritance and disagreement work across many agents?
8. How should agent-memory quality be tested continuously as data and models
   evolve?
9. Can state-machine, transaction, and retrieval planning share one cost model?
10. Which claimed advantages survive comparison with a well-engineered
    PostgreSQL-centered composition?

## 13. Recommendation

Do not begin by writing a new storage engine.

Begin with a reference implementation on a proven transactional substrate,
using typed assertions, bitemporal columns, provenance, durable machine state,
effect intents, pgvector/text/graph projections, object storage, and a typed
Agent IR. Measure where the composition fails.

Only replace the underlying engine when the benchmark identifies a structural
bottleneck that cannot be addressed through extensions, indexing, execution
planning, or storage tiering.

The proof of value should not be "one endpoint instead of six." It should be:

> Under identical semantics and failure conditions, the agent-first system
> completes more authorized tasks with fewer round trips and less context,
> while preserving or improving transactional correctness, recovery,
> provenance, latency, cost, and human auditability.

The conventional baseline must be allowed equivalent server-side composition,
transactions, and a single bounded RPC. Otherwise fewer agent calls would prove
only that one API was packaged differently. Raw multi-tool execution remains a
useful secondary arm, but not the primary comparison.

The companion
[PROOF_OF_CONCEPT_BLUEPRINT.md](PROOF_OF_CONCEPT_BLUEPRINT.md) makes that claim
falsifiable.

## References

1. Groth, Gibson, and Velterop, "The Anatomy of a Nanopublication," 2010.
   <https://doi.org/10.3233/ISU-2010-0613>
2. Clark, Ciccarese, and Goble, "Micropublications," 2014.
   <https://doi.org/10.1186/2041-1480-5-28>
3. Vrandecic and Krotzsch, "Wikidata: A Free Collaborative Knowledgebase,"
   2014. <https://doi.org/10.1145/2629489>
4. W3C, "RDF 1.2 Concepts and Abstract Syntax."
   <https://www.w3.org/TR/rdf12-concepts/>
5. Datomic, "Data Model." <https://docs.datomic.com/data-model.html>
6. Green, Karvounarakis, and Tannen, "Provenance Semirings," 2007.
   <https://doi.org/10.1145/1265530.1265535>
7. W3C, "PROV-DM: The PROV Data Model," 2013.
   <https://www.w3.org/TR/prov-dm/>
8. Benjelloun et al., "ULDBs: Databases with Uncertainty and Lineage," 2006.
   <https://ilpubs.stanford.edu:8090/703/>
9. Suciu et al., *Probabilistic Databases*, 2011.
   <https://doi.org/10.2200/S00362ED1V01Y201105DTM016>
10. Dalvi and Suciu, "Efficient Query Evaluation on Probabilistic Databases,"
    2007. <https://doi.org/10.1007/s00778-006-0004-3>
11. Katsuno and Mendelzon, "On the Difference between Updating a Knowledge
    Base and Revising It," 1991.
    <https://static.aminer.org/pdf/PDF/000/479/817/on_the_difference_between_updating_a_knowledge_base_and_revising.pdf>
12. Belnap, "A Useful Four-Valued Logic," 1977.
    <https://doi.org/10.1007/978-94-010-1161-7_2>
13. Arenas, Bertossi, and Chomicki, "Consistent Query Answers in Inconsistent
    Databases," 1999. <https://doi.org/10.1145/303976.303983>
14. Bailis et al., "Coordination Avoidance in Database Systems," 2015.
    <https://arxiv.org/abs/1402.2237>
15. Hellerstein and Alvaro, "Keeping CALM," 2020.
    <https://doi.org/10.1145/3369736>
16. PostgreSQL, "Transaction Isolation."
    <https://www.postgresql.org/docs/current/transaction-iso.html>
17. Zhou et al., "FoundationDB: A Distributed Unbundled Transactional Key
    Value Store," 2021. <https://www.foundationdb.org/files/fdb-paper.pdf>
18. Corbett et al., "Spanner: Google's Globally-Distributed Database," 2012.
    <https://research.google/pubs/spanner-googles-globally-distributed-database-2/>
19. Apache Arrow, "Columnar Format."
    <https://arrow.apache.org/docs/format/Columnar.html>
20. Substrait, "Specification and ecosystem." <https://substrait.io/>
21. Orogat and Mansour, "Is Agent Memory a Database? Rethinking Data
    Foundations for Long-Term AI Agent Memory," 2026.
    <https://arxiv.org/abs/2605.26252>
22. Zhou et al., "Are We Ready For An Agent-Native Memory System?" 2026.
    <https://arxiv.org/abs/2606.24775>
23. Alake et al., "Oracle Agent Memory as an Enterprise Memory Substrate for
    Long-Horizon AI Agents," 2026.
    <https://arxiv.org/abs/2607.13157>
24. Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture for Agent
    Memory," 2025. <https://arxiv.org/abs/2501.13956>
25. ISO/IEC 39075:2024, "GQL."
    <https://www.iso.org/standard/76120.html>
26. ISO/IEC 9075-16:2023, "SQL/PGQ."
    <https://www.iso.org/standard/79473.html>
27. W3C, "Defining N-ary Relations on the Semantic Web," 2006.
    <https://www.w3.org/TR/swbp-n-aryRelations/>
28. Letta, "MemFS." <https://docs.letta.com/concepts/memfs>
29. Mem0, "How Mem0 Works." <https://docs.mem0.ai/core-concepts/how-it-works>
30. Graphiti source and documentation. <https://github.com/getzep/graphiti>
31. Neo4j Labs, "Agent Memory." <https://github.com/neo4j-labs/agent-memory>
32. LangGraph, "Persistence."
    <https://docs.langchain.com/oss/python/langgraph/persistence>
33. Temporal, "Workflow Execution."
    <https://docs.temporal.io/workflow-execution>
34. Restate, "Durable Steps."
    <https://docs.restate.dev/develop/ts/durable-steps>
35. DBOS, "Workflows." <https://docs.dbos.dev/typescript/tutorials/workflow-tutorial>
36. Microsoft, "Durable Task code constraints."
    <https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-code-constraints>
37. XTDB documentation. <https://docs.xtdb.com/>
38. CozoDB, "Time Travel." <https://docs.cozodb.org/en/latest/timetravel.html>
39. Lance, "Lakehouse Format Specifications." <https://lance.org/format/>
40. Li et al., "Can LLM Already Serve as A Database Interface? A BIg Bench
    for Large-Scale Database Grounded Text-to-SQLs," 2023.
    <https://arxiv.org/abs/2305.03111>
41. Scholak et al., "PICARD," 2021.
    <https://arxiv.org/abs/2109.05093>
42. Model Context Protocol, specification revision 2026-07-28.
    <https://modelcontextprotocol.io/specification/2026-07-28>
43. Apache Kafka, "Design."
    <https://github.com/apache/kafka/blob/trunk/docs/design/design.md>
44. OWASP GenAI Security Project, "Prompt Injection."
    <https://genai.owasp.org/llmrisk/llm01-prompt-injection/>
45. Chen et al., "AgentPoison," 2024.
    <https://arxiv.org/abs/2407.12784>
