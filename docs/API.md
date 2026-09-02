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
| `seed_inventory` | `inventory:admin` | Create initial inventory for a SKU and location |
| `reserve_inventory` | `orders:write` | Reserve stock and start an order workflow |
| `request_payment` | `effects:write` | Reserve effect budget and create a payment intent |
| `get_machine` | `data:read` | Read current workflow state |
| `list_effects` | `data:read` | Read effect state |
| `process_timers` | `workflows:run` | Process timers using database server time |

`record_payment_outcome` exists only in the development profile. The production
profile accepts terminal payment state only from the effect worker.

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
