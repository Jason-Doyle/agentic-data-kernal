# Agentic Data Kernel

Open source data infrastructure for long-running software agents.

Agentic Data Kernel keeps knowledge, workflow state, and external effects in a
single governed system. It is designed for applications that need to answer:

- What is currently known?
- When was it valid?
- Where did it come from?
- What conflicts with it?
- Which workflow or external action depended on it?

## Capabilities

- Bitemporal assertions with evidence, epistemic kind, perspective, and typed
  uncertainty
- Explicit `known`, `unknown`, and `conflicted` resolution results
- Hybrid lexical, vector, relational, graph, and temporal retrieval
- Durable workflow state, timers, idempotency, and execution receipts
- Transactional inventory reservations and payment effect intents
- Scoped API keys, purpose binding, and PostgreSQL row-level security
- Encrypted immutable artifact storage with key rotation
- Authorized effect delivery with budgets, retries, and status reconciliation
- HTTP, MCP, TypeScript, CLI, and read-only local SQL interfaces

## Use cases

| Use case | What the kernel provides |
| --- | --- |
| Catalog and master-data reconciliation | Source-backed claims, conflicting values, temporal correction, and reviewable resolution |
| Persistent agent memory | Distinct observations, facts, inferences, decisions, and experiences with provenance |
| Retail order workflows | Inventory holds, expiry timers, payment effects, idempotent retries, and durable order state |
| Customer support operations | Tenant-scoped context retrieval, current-state checks, and evidence-linked decisions |
| Incident response | Temporal observations, hypotheses, workflow history, and controlled remediation effects |
| Controlled payment automation | Purpose-scoped credentials, effect budgets, authorization fences, and audit receipts |

See [docs/USE_CASES.md](docs/USE_CASES.md) for detailed flows and current
support.

## Project status

The current release is `0.2.0-alpha.1`.

Two runtime profiles are maintained:

- **Development profile:** embedded SQLite, loopback HTTP, local MCP, and
  read-only SQL for inspection.
- **PostgreSQL profile:** PostgreSQL 18, pgvector, forced tenant isolation,
  authenticated APIs, encrypted artifacts, provider embeddings, effect
  workers, TLS, migrations, metrics, backup, restore, and load tooling.

The PostgreSQL profile targets bounded single-primary deployments. See
[docs/PRODUCTION.md](docs/PRODUCTION.md) before exposing it outside a trusted
environment.

## Quick start

Requirements:

- Node.js 22.5 or newer
- npm 10 or newer

```powershell
npm install
npm test
npm run example
```

The sample workflow:

1. stores conflicting supplier claims about a product;
2. preserves both claims and returns an explicit conflict;
3. searches across a customer, product, and incident graph;
4. reserves inventory transactionally;
5. creates a durable payment effect;
6. records the provider outcome;
7. confirms the order without duplicating inventory changes on replay.

The sample database is written to `.data\example.db`.

Node's built-in `node:sqlite` API is experimental in Node 22. This affects only
the development profile.

## Development CLI

Build:

```powershell
npm run build
```

Initialize a database:

```powershell
node --no-warnings dist\cli.js init --db .data\agentic.db
```

Execute an operation:

```powershell
node --no-warnings dist\cli.js execute `
  --db .data\agentic.db `
  --file examples\put-product.json
```

Inspect state with read-only SQL:

```powershell
node --no-warnings dist\cli.js sql `
  --db .data\agentic.db `
  --query "SELECT assertion_id, predicate, status FROM assertions"
```

The SQL interface accepts `SELECT`, `EXPLAIN`, and schema-inspection PRAGMAs.

## Development HTTP

```powershell
npm run serve
```

Default address: `http://127.0.0.1:4318`

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness |
| `GET /v1/catalog` | Supported operations and guarantees |
| `POST /v1/execute` | Execute one Agent Intent operation |

The development server is loopback-only and has no network SQL route.

## MCP

Start the development MCP server:

```powershell
npm run mcp
```

It publishes `agentic-data://catalog` and these tools:

- `execute_intent`
- `search_knowledge`
- `resolve_claims`
- `reserve_inventory`
- `get_machine`

Use `npm run prod:mcp` for an authenticated PostgreSQL-backed MCP process.

## PostgreSQL deployment

Requirements:

- Docker with Compose
- An OpenAI-compatible 1536-dimensional embedding endpoint
- Generated database, authentication, and artifact-encryption secrets

```powershell
Copy-Item .env.example .env
.\scripts\generate-secrets.ps1
docker compose --profile server up --build
```

The included deployment:

- creates a non-superuser runtime database role;
- applies checksum-verified migrations separately;
- initializes artifact-directory ownership;
- runs the API and effect worker independently;
- publishes only the Caddy TLS endpoint;
- keeps PostgreSQL bound to loopback by default.

Full setup and operating procedures are in
[docs/PRODUCTION.md](docs/PRODUCTION.md).

## Agent Intent

Version 0.1 executes one typed operation per envelope:

```json
{
  "protocolVersion": "0.1",
  "requestId": "claim-1",
  "idempotencyKey": "claim-1",
  "principal": {
    "tenantId": "example-retail",
    "principalId": "catalog-agent",
    "purpose": "catalog-ingestion"
  },
  "operation": {
    "op": "assert",
    "assertion": {
      "subjectEntityId": "product:sku-17",
      "predicate": "packaged_weight",
      "object": {
        "type": "number",
        "value": 4.8,
        "unit": "kg"
      },
      "kind": "reported_fact",
      "strength": {
        "type": "rank",
        "value": "normal"
      }
    }
  }
}
```

The production server derives authority from the authenticated API key and
rejects envelopes whose tenant, principal, or purpose does not match.

## Architecture

```text
HTTP / MCP / TypeScript / CLI
             |
     Agent Intent validation
             |
   identity, scope, purpose
             |
 knowledge + workflow kernel
   | assertions and evidence
   | conflict resolution
   | hybrid retrieval
   | timers and state machines
   | effects and receipts
             |
 SQLite development adapter
             or
 PostgreSQL + pgvector + RLS
```

## Documentation

- [Use cases](docs/USE_CASES.md)
- [Production profile](docs/PRODUCTION.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Boundaries

- The included deployment uses one PostgreSQL primary.
- The default rate limiter is process-local.
- The vector schema currently requires 1536-dimensional embeddings.
- Effect receivers must honor idempotency keys.
- Projection epochs, multi-operation plans, and context-package optimization
  are not yet implemented.

## License

Apache-2.0. See [LICENSE](LICENSE).
