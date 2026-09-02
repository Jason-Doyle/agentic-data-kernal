# Use Cases

Agentic Data Kernel is intended for applications where knowledge changes over
time and software agents can influence durable business state.

For adoption criteria and costs, see
[Benefits and tradeoffs](TRADEOFFS.md).

## Support levels

| Level | Meaning |
| --- | --- |
| Supported | The repository includes the data model, operation, and tests |
| Supported foundation | Generic primitives and invariants are implemented; the canonical domain scenario follows |
| Extension point | Core primitives exist, but domain policy belongs in the application |
| Planned | The architecture reserves the capability, but it is not implemented |

## Catalog and master-data reconciliation

**Support level:** Supported

Supplier feeds, internal systems, and operator edits often disagree about the
same product, customer, asset, or policy. Overwriting the old value loses the
source and the history of the disagreement.

The kernel stores each reported value as an assertion with:

- subject and predicate;
- typed value;
- valid time and system time;
- source artifact;
- epistemic kind;
- authority and uncertainty;
- supersession history.

Applications can return all candidates, report a conflict, or apply an explicit
resolution policy such as latest value or highest authority.

Example:

```text
Supplier A: packaged weight = 4.8 kg
Supplier B: packaged weight = 5.1 kg

Resolution: conflicted
```

Relevant operations:

- `put_entity`
- `put_artifact`
- `assert`
- `resolve`
- `search`

## Persistent agent memory

**Support level:** Supported

Long-running agents need more structure than a list of embedded messages. The
kernel distinguishes:

- observations;
- reported facts;
- inferences;
- predictions;
- hypotheses;
- decisions;
- directives;
- experiences.

This distinction allows an application to keep a customer statement separate
from a model inference, or a past decision separate from current policy.

Typical uses:

- user and account context;
- prior task outcomes;
- operational facts;
- reusable procedures;
- model-generated hypotheses with source evidence.

The application remains responsible for deciding which memories are admitted,
reviewed, expired, or promoted into authoritative state.

## Retail inventory and order processing

**Support level:** Supported

The included retail workflow demonstrates how knowledge and transactions work
together:

```text
new -> reserved -> payment_pending -> confirmed
                 \-> failed
reserved -> cancelled on expiry
```

The kernel provides:

- conditional inventory reservation;
- an invariant that reserved quantity cannot exceed stock;
- reservation-expiry timers;
- deterministic workflow revisions;
- payment effect intents;
- exact decimal money values;
- effect-budget reservation;
- idempotent provider delivery;
- `unknown` outcomes and provider-status reconciliation;
- inventory commit or release in the same transaction as the final state.

This is a reference workflow. Tax, fraud, fulfillment, returns, and accounting
rules are extension points.

## Customer support operations

**Support level:** Extension point

A support application can combine:

- current authoritative account and order state;
- prior conversations stored as encrypted artifacts;
- extracted facts and inferences;
- policy and entitlement assertions;
- semantically related cases;
- graph relationships between customers, products, incidents, and services.

The kernel provides tenant isolation, evidence links, temporal filtering,
conflict reporting, and durable receipts. The application supplies identity
verification, support policy, remedy limits, and approval rules.

## Incident response

**Support level:** Supported

Operational events can be represented without treating every hypothesis as a
confirmed cause:

```text
observation: error rate increased after deployment
hypothesis: cache invalidation caused the increase
decision: roll back deployment under incident policy
effect: execute the approved rollback
```

The kernel provides temporal assertions, typed causal lineage, generic durable
workflow state, decision- and policy-bound effect authorization, retries,
unknown-outcome reconciliation, and execution history. Integrations with
telemetry systems and deployment platforms remain application adapters.

The canonical scenario is documented in
[Flagship SRE Scenario](SRE_SCENARIO.md).

## Controlled external actions

**Support level:** Extension point

The PostgreSQL profile currently exposes a bounded payment-capture workflow
through:

- high-entropy API keys stored as peppered scrypt-derived hashes;
- operation scopes;
- approved purposes;
- expiry and revocation;
- per-key effect currency and budget;
- transactionally reserved effect amounts;
- allowlisted HTTPS targets;
- authorization fences;
- stable effect and idempotency IDs;
- provider-status reconciliation.

The generic effect operation supports infrastructure changes, procurement,
notifications, and similar actions without applying retail inventory logic.
Applications still supply typed receiver contracts and domain policy.

## Local and embedded applications

**Support level:** Supported

The SQLite profile supports:

- local command-line tools;
- desktop or single-user applications;
- offline or single-user workflows using the assertion model;
- MCP integrations on a developer workstation;
- inspection through read-only SQL.

It is not a multi-tenant production profile. Use PostgreSQL when authenticated
network access, forced tenant isolation, encrypted artifacts, or external
effects are required.

## Analytics and historical reporting

**Support level:** Extension point

Bitemporal assertions and workflow history support questions such as:

- What was believed at a previous system time?
- What was valid during a business-time interval?
- Which source caused a value to change?
- Which assertions and policies supported an effect?
- Which workflows remain pending or unknown?

The current implementation queries PostgreSQL directly. Snapshot-versioned
analytical projections and columnar exports are planned.

## Not a fit

Agentic Data Kernel is not intended to be:

- a general replacement for every relational database;
- a payment processor;
- a model-serving platform;
- an unrestricted remote SQL gateway;
- a vector store without transactional or provenance requirements;
- an agent framework that decides business policy for the application.
