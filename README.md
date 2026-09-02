# Agentic Data Kernel

> **Author note, 2 September 2026, Jason Doyle**
>
> This project began as a feature forked from a private project and is now
> maintained independently as open source. The documentation is heavily AI
> assisted and may contain errors. Verify important behavior against the
> implementation, tests, and current release before using it in production.

[![CI](https://github.com/Jason-Doyle/agentic-data-kernel/actions/workflows/ci.yml/badge.svg)](https://github.com/Jason-Doyle/agentic-data-kernel/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Jason-Doyle/agentic-data-kernel/actions/workflows/codeql.yml/badge.svg)](https://github.com/Jason-Doyle/agentic-data-kernel/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

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
- Bounded lexical and HNSW vector candidates with graph and temporal reranking
- Versioned embedding spaces configurable up to 2000 indexed dimensions
- FK-backed lineage across evidence, assertions, workflow revisions, and
  effects
- Generic durable workflows with guarded revisions and terminal states
- Durable workflow state, timers, idempotency, and execution receipts
- Transactional inventory reservations and payment effect intents
- Scoped API keys, purpose binding, and PostgreSQL row-level security
- Encrypted immutable artifact storage with key rotation
- Authorized effect delivery with budgets, retries, and status reconciliation
- Decision- and policy-bound non-retail effects with isolated finalization
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

The current release is `0.2.0-alpha.2`.

Two runtime profiles are maintained:

- **Development profile:** embedded SQLite, loopback HTTP, local MCP, and
  read-only SQL for inspection.
- **PostgreSQL profile:** PostgreSQL 18, pgvector, forced tenant isolation,
  authenticated APIs, encrypted artifacts, provider embeddings, effect
  workers, TLS, migrations, metrics, backup, restore, and load tooling.

The PostgreSQL profile targets bounded single-primary deployments. See
[docs/PRODUCTION.md](docs/PRODUCTION.md) before exposing it outside a trusted
environment.

## Install

Install the TypeScript library:

```powershell
npm install agentic-data-kernel@next
```

Run the embedded example without cloning the repository:

```powershell
npx --yes agentic-data-kernel@next example --db .data\example.db
```

Published prereleases use the npm `next` tag. Production applications should
pin an exact package version.

```ts
import { AgenticKernel, SqliteStore } from "agentic-data-kernel";

const store = new SqliteStore(".data/app.db");
const kernel = new AgenticKernel(store);
```

The npm package provides:

- `agentic-data-kernel` and `agentic-data` for the embedded CLI;
- `agentic-data-prod` for production administration and runtime commands;
- `agentic-data-kernel/production` for PostgreSQL integrations.

## Source quick start

Requirements:

- Node.js 22.19 or newer
- npm 10 or newer

```powershell
npm install
npm run build
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

Start the development MCP server from a published package:

```powershell
npx --yes agentic-data-kernel@next mcp --db .data\agentic.db
```

Or start it from a source checkout:

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

## Integration examples

| Example | Command |
| --- | --- |
| TypeScript library | `npm run example:library` |
| MCP client | `npm run example:mcp` |
| Authenticated production HTTP | `npm run example:production-http` |
| Production retail workflow | `npm run example:production-retail` |
| Embedding provider | `npm run example:embedding` |
| Embedding protocol helper | `npm run example:mock-embeddings` |
| Effect receiver contract | `npm run example:mock-effects` |

Setup, environment variables, and receiver contracts are documented in
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## PostgreSQL deployment

Requirements:

- Docker with Compose
- An OpenAI-compatible embedding endpoint
- Generated database, authentication, and artifact-encryption secrets

Use the versioned production image:

```powershell
Copy-Item .env.example .env
.\scripts\generate-secrets.ps1
$env:AGENTIC_DATA_IMAGE = "ghcr.io/jason-doyle/agentic-data-kernel:0.2.0-alpha.2"
docker compose --profile server pull
docker compose --profile server up --no-build
```

Or build the image from the checked-out source:

```powershell
Copy-Item .env.example .env
.\scripts\generate-secrets.ps1
docker compose --profile server up --build
```

The included deployment:

- creates a non-superuser runtime database role;
- applies checksum-verified migrations separately;
- configures one indexed embedding space from the selected provider model,
  version, and dimensions;
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
- [Benefits and tradeoffs](docs/TRADEOFFS.md)
- [Integration guide](docs/INTEGRATIONS.md)
- [API reference](docs/API.md)
- [Production profile](docs/PRODUCTION.md)
- [Release process](docs/RELEASING.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)

## Boundaries

- The included deployment uses one PostgreSQL primary.
- The default rate limiter is process-local.
- One embedding model, version, and dimension is active per deployment.
- HNSW-indexed vectors are limited to 2000 dimensions.
- Changing the active embedding space after assertions exist requires an
  explicit re-embedding migration.
- Effect receivers must honor idempotency keys.
- Projection epochs, multi-operation plans, and context-package optimization
  are not yet implemented.

## License

Apache-2.0. See [LICENSE](LICENSE).
