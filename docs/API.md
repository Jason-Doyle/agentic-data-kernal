# API Reference

## Interfaces

| Interface | Profile | Entry point |
| --- | --- | --- |
| TypeScript library | Development | `agentic-data-kernel` |
| TypeScript production library | PostgreSQL | `agentic-data-kernel/production` |
| CLI | Development | `agentic-data` |
| CLI | PostgreSQL | `agentic-data-prod` |
| HTTP | Development | `POST /v1/execute` |
| HTTP | PostgreSQL | `POST /v1/execute` |
| MCP | Development | `agentic-data-kernel mcp` |
| MCP | PostgreSQL | `agentic-data-prod mcp` |

## Intent envelope

```json
{
  "protocolVersion": "0.1",
  "requestId": "unique-request-id",
  "idempotencyKey": "stable-retry-key",
  "principal": {
    "tenantId": "tenant",
    "principalId": "service",
    "purpose": "approved-purpose"
  },
  "operation": {}
}
```

`requestId` identifies one call. `idempotencyKey` identifies one logical
operation across retries within a tenant and principal. Reusing a key with
different operation content in that scope is rejected. Another principal has a
separate idempotency namespace.

In the PostgreSQL profile, the supplied principal must exactly match the
authenticated API key.

## Operations

| Operation | Scope | Description |
| --- | --- | --- |
| `put_entity` | `data:write` | Create or update an entity identity |
| `put_artifact` | `data:write` | Store immutable source evidence |
| `assert` | `data:write` | Add or supersede a typed temporal assertion |
| `resolve` | `data:read` | Return known, unknown, conflicting, or policy-selected values |
| `search` | `data:read` | Run hybrid retrieval with optional graph filters |
| `create_workflow` | `workflows:run` | Create a non-retail durable workflow |
| `advance_workflow` | `workflows:run` | Commit a guarded workflow transition |
| `request_effect` | `effects:write` | Request an authorized generic external effect |
| `add_lineage` | `data:write` | Add a typed causal link between durable records |
| `seed_inventory` | `inventory:admin` | Create initial inventory for a SKU and location |
| `reserve_inventory` | `orders:write` | Reserve stock and start an order workflow |
| `request_payment` | `effects:write` | Reserve effect budget and create a payment intent |
| `get_machine` | `data:read` | Read current workflow state |
| `list_effects` | `data:read` | Read effect state |
| `process_timers` | `workflows:run` | Process timers using database server time |

`record_payment_outcome` exists only in the development profile. The production
profile accepts terminal effect state only from the effect worker.

`record_effect_outcome` is the development-profile equivalent for generic
effects. It is rejected by the production API and MCP surface.

## Generic workflows

`create_workflow` stores a caller-defined workflow type, initial state, JSON
data, revision 1, and an append-only history record. The reserved
`retail_order` type cannot be created or changed through generic operations.

`advance_workflow` requires both the expected revision and expected state. It
increments the revision exactly once and can mark the workflow terminal.
Terminal workflows cannot transition again.

The application owns each generic workflow's allowed state graph and grants
`workflows:run` only to principals allowed to enact it. The kernel enforces
revision, state, terminality, history, tenancy, and retail isolation rather
than interpreting domain transition policy.

## Generic effects

`request_effect` requires:

- a non-retail workflow and exact originating revision;
- active `decision` and `directive` assertions from the same tenant;
- an HTTPS target and status URL accepted by production network policy;
- an `effects:write` key with the current purpose;
- sufficient budget when a non-zero budget amount is supplied.

The effect worker owns delivery, retry, unknown-outcome reconciliation, and
budget settlement. A generic effect never commits inventory or changes the
workflow automatically. The agent advances the workflow only after reading the
durable effect outcome.

Provider idempotency keys are bound to one request hash within a tenant and
provider origin. Exact retries return the existing effect; reuse for a
different target path, payload, workflow, decision, policy, or budget is
rejected before additional budget can be reserved.

## Causal lineage

`add_lineage` accepts these endpoint types:

```text
artifact
assertion
workflow_revision
effect
```

Relations are:

```text
evidence_for
supports
contradicts
governs
authorizes
produces
verifies
```

Endpoints are tenant-scoped and FK validated. `authorizes` requires a decision,
`governs` requires a directive, and `verifies` targets an observation.
Creating an assertion with a source artifact automatically records
`evidence_for`. Generic effect creation automatically records decision,
policy, and workflow-revision links.

## Typed values

```text
string
number with optional unit
boolean
timestamp
entity reference
JSON
```

Example:

```json
{
  "type": "number",
  "value": 4.8,
  "unit": "kg"
}
```

## Epistemic kinds

```text
observation
reported_fact
inference
prediction
hypothesis
decision
directive
experience
```

Kinds identify how a value entered the system. They do not grant authority.

## Strength types

| Type | Meaning |
| --- | --- |
| `none` | No confidence semantics supplied |
| `rank` | Preferred, normal, or deprecated |
| `probability` | Calibrated probability with optional definition |
| `interval` | Numeric uncertainty interval |
| `evidence_count` | Supporting and considered evidence counts |

Retrieval similarity is returned separately and is never treated as
probability.

## Resolution

Policies:

- `none`
- `latest`
- `highest_authority`

Statuses:

- `known`
- `unknown`
- `conflicted`
- `resolved_with_conflict`

`resolved_with_conflict` preserves the non-selected candidates.

## Search

Search can combine:

- text;
- vector similarity;
- predicate and epistemic-kind filters;
- perspective;
- valid time and system time;
- a related entity and maximum graph depth.

The PostgreSQL profile stores provider vectors in pgvector. The development
profile uses deterministic feature vectors for local behavior only.

The PostgreSQL profile retrieves bounded vector and lexical candidate sets
through HNSW and full-text indexes before calculating final combined scores.
Temporal, status, tenant, optional field, and graph constraints remain inside
candidate selection so bounded retrieval does not reintroduce stale or
out-of-scope rows.

## Retail workflow

```text
new -> reserved -> payment_pending -> confirmed
                 \-> failed
reserved -> cancelled
```

`reserve_inventory` requires:

```json
{
  "op": "reserve_inventory",
  "orderId": "1001",
  "sku": "camera-1",
  "location": "store-1",
  "quantity": 1,
  "holdSeconds": 600,
  "idempotencyKey": "reserve-1001"
}
```

`request_payment` uses an exact decimal string:

```json
{
  "op": "request_payment",
  "instanceId": "order:1001",
  "amount": "149.98",
  "currency": "USD",
  "paymentTarget": "https://payments.example.com/capture",
  "paymentStatusUrl": "https://payments.example.com/status/payment-1001",
  "idempotencyKey": "payment-1001"
}
```

## HTTP

Production requests require:

```text
Authorization: Bearer <token>
X-Agent-Purpose: <approved-purpose>
Content-Type: application/json
```

Routes:

```text
GET  /health/live
GET  /health/ready
GET  /metrics
GET  /v1/catalog
POST /v1/execute
```

The production API does not expose SQL.

## Errors

| HTTP status | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_input` | Schema, type, time, or value validation failed |
| `401` | `authentication_failed` | API key is missing or invalid |
| `403` | `authorization_failed` | Purpose or scope is not allowed |
| `403` | `unauthorized` | Operation-specific authority failed |
| `404` | `not_found` | Required entity, artifact, workflow, or route is absent |
| `409` | `conflict` | State, idempotency, inventory, or immutability conflict |
| `429` | `rate_limited` | Request rate exceeded |
| `503` | `maintenance` | Coordinated backup or restore paused writes |

Internal errors return a generic message and request ID.

## Versioning

The current envelope version is `0.1`. New required fields or changed operation
semantics require a new protocol version. Additive optional fields may remain
within the current version when existing behavior is preserved.
