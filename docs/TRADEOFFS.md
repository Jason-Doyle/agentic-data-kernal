# Benefits and Tradeoffs

Agentic Data Kernel is most useful when an application needs durable knowledge,
workflow state, and controlled external actions to share one contract.

It is not intended to replace every operational database, analytical platform,
workflow engine, or vector store.

## Demonstrated benefits

The repository currently demonstrates these properties through runnable
examples and automated tests.

### Conflicting information remains inspectable

Two sources can report different values without one silently replacing the
other. Resolution returns:

- `known`;
- `unknown`;
- `conflicted`;
- `resolved_with_conflict`.

This is useful for catalog data, customer context, operational facts, and other
domains where source disagreement is normal.

### Time and provenance are part of the record

Assertions carry valid time, system time, source evidence, epistemic kind,
perspective, and uncertainty. Applications can distinguish:

- what was reported;
- when it applied;
- when the system learned it;
- whether it was observed, inferred, predicted, or decided;
- which source supported it.

### Workflow and business state change together

Inventory reservations, order revisions, timers, payment effects, budgets, and
receipts use the same transaction boundary. A workflow cannot advance while
leaving its related inventory change uncommitted.

### External actions have explicit safety boundaries

The PostgreSQL profile provides:

- scoped and purpose-bound credentials;
- effect budgets and currencies;
- stable idempotency keys;
- authorization fences;
- allowlisted HTTPS destinations;
- ambiguous `unknown` outcomes;
- provider-status reconciliation;
- durable execution receipts.

### Tenant isolation is enforced below the API

The production profile derives identity from authenticated keys and uses forced
PostgreSQL row-level security. Application mistakes cannot opt out of tenant
filters through ordinary runtime queries.

### Multiple interfaces share the same semantics

Applications can use TypeScript, HTTP, MCP, or the CLI. Local operators can
inspect the development database with read-only SQL. These interfaces use the
same operation and result types rather than separate domain APIs.

## Expected benefits that are not yet proven

The architecture is intended to reduce application glue and improve the
reliability of long-running agent workflows. The SRE benchmark now provides
structural and correctness evidence, but it does not establish that the
project:

- lowers total infrastructure cost;
- improves throughput or latency;
- reduces model context consumption;
- increases end-to-end task completion;
- requires fewer operator hours than a conventional composed stack.

Those claims require controlled comparisons against alternatives such as
PostgreSQL plus a vector store and workflow engine.

## SRE comparison

The repository now includes a deterministic comparison against a competent
conventional PostgreSQL implementation. Correctness is required to remain
equal: both variants deliver once, reconcile once, resolve the incident, and
answer the same nine durable audit questions.

The comparison measures application-authored code and tables while separately
disclosing total operated tables, kernel source size, database footprint, and
informational runtime. It does not claim runtime or storage superiority. See
[benchmarks/sre/results/report.md](../benchmarks/sre/results/report.md).

## Costs and disadvantages

### More concepts than ordinary CRUD

Teams must understand assertions, authoritative state, valid time, system time,
epistemic kinds, effects, receipts, scopes, purposes, and reconciliation.

For a simple application with stable rows and no long-running workflows, this
model can be unnecessary overhead.

### Higher storage usage

History, evidence links, embeddings, workflow events, effect attempts, and
receipts consume more storage than latest-value tables.

Retention and deletion policies need deliberate design.

### Additional write latency

Strong transactions, receipt generation, encryption, embedding calls, and
effect-budget checks add work to write paths. Embedding-provider latency is
especially visible when assertions are created.

### External dependencies remain

The PostgreSQL profile depends on:

- PostgreSQL and pgvector;
- an embedding provider;
- encrypted artifact storage;
- a TLS edge;
- external receivers that honor idempotency.

The kernel coordinates these dependencies but does not eliminate them.

### Operational complexity

Production deployment includes an API, effect worker, PostgreSQL, Caddy,
artifact storage, migrations, backups, and key management.

This is simpler than some multi-product stacks and more complex than a single
application database.

### Current implementation boundaries

- The release is alpha.
- The included deployment uses one PostgreSQL primary.
- The default rate limiter is process-local.
- One embedding space is active per deployment.
- HNSW-indexed vectors are limited to 2000 dimensions.
- Model or dimension changes require explicit re-embedding once assertions
  exist.
- Generic workflow state graphs and transition policy remain application-owned.
- The built-in retail order and payment flow remains a compatibility adapter.
- Projection epochs and multi-operation plans are not implemented.

## Comparison with common alternatives

| Approach | Strength | Limitation relative to this project |
| --- | --- | --- |
| PostgreSQL with application tables | Mature transactions and broad tooling | Provenance, conflict semantics, and effects remain application conventions |
| Vector database | Strong semantic retrieval | Similarity does not provide authoritative state, transactions, or workflow recovery |
| Graph database | Strong relationship traversal | Operational transactions, evidence lifecycle, and external effects usually remain separate |
| Workflow engine | Durable retries and timers | Knowledge retrieval and transactional business records remain in another system |
| Custom application glue | Maximum flexibility | Correctness, idempotency, audit, and tenant behavior vary by integration |
| Agentic Data Kernel | Shared knowledge, workflow, and effect contract | More opinionated model and a younger implementation |

## Good adoption signals

Consider the project when several of these are true:

- sources can disagree and the disagreement matters;
- historical belief and business validity are both required;
- agents operate across multiple sessions or long-running workflows;
- external actions need budgets, idempotency, and reconciliation;
- tenant isolation must be enforced in the database;
- operators need a durable explanation of why an action occurred;
- HTTP, MCP, and library clients should share one contract.

## Poor adoption signals

Use a simpler system when:

- the application is straightforward CRUD;
- one authoritative source always supplies the current value;
- workflows complete inside one request;
- no external side effects require retry or reconciliation;
- provenance and historical correction are not needed;
- existing database and workflow tooling already meets the requirements with
  little integration burden.

## Decision checklist

Before adopting the kernel, answer:

1. Which data is authoritative and which data is an assertion?
2. Which assertion kinds and uncertainty types are necessary?
3. How long must evidence, history, and receipts be retained?
4. Which external actions require budgets or approval?
5. Can every effect receiver honor a stable idempotency key?
6. Which embedding model, version, and dimension meet the workload's quality
   and cost targets?
7. Is a single-primary PostgreSQL deployment sufficient?
8. Which comparative metric would justify the added complexity?

If these questions do not have concrete answers, begin with a conventional
database and add the kernel only where its semantics are required.
