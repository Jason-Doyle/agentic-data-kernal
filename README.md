# Agentic Data Kernel

An epistemic state and workflow kernel with a local development profile and an
authenticated PostgreSQL production profile.

The project combines:

- bitemporal assertions with evidence, epistemic kind, perspective, and typed
  uncertainty;
- explicit `known`, `unknown`, and `conflicted` resolution results;
- hybrid lexical/vector retrieval with bounded graph traversal;
- transactional retail inventory and durable order state;
- deterministic timers, effect intents, idempotency, and execution receipts;
- a typed Agent Intent IR;
- an MCP server, local HTTP API, and read-only SQL interface for people.

Two profiles are included:

- **Development:** embedded SQLite, loopback HTTP, local MCP, and human
  read-only SQL.
- **Production preview:** PostgreSQL 18, pgvector, forced tenant RLS,
  authenticated scoped keys, encrypted artifacts, real embeddings, budgeted
  effect dispatch, migrations, metrics, backup/restore, and load tooling.

## Requirements

- Node.js 22.5 or newer
- npm 10 or newer
- Docker with Compose for the included PostgreSQL production environment

Node's built-in `node:sqlite` API is experimental in Node 22. The CLI suppresses
that runtime warning; the limitation remains.

## Production profile

See:

- [docs/PRODUCTION.md](docs/PRODUCTION.md)
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)
- [SECURITY.md](SECURITY.md)

Minimal PostgreSQL setup:

```powershell
Copy-Item .env.example .env
.\scripts\generate-secrets.ps1
docker compose up -d postgres
docker compose run --rm bootstrap
npm run prod:migrate
```

After replacing every `.env` placeholder, run:

```powershell
docker compose --profile server up --build
```

The production API accepts only authenticated requests and has no SQL route.

## Run locally

```powershell
npm install
npm test
npm run demo
```

The demo:

1. stores conflicting supplier claims about a product;
2. returns an explicit conflict instead of overwriting either claim;
3. performs hybrid retrieval across a small customer/product/incident graph;
4. reserves inventory transactionally;
5. creates a durable payment effect;
6. records the payment outcome;
7. confirms the order without duplicating inventory changes on replay.

The demo database is written to `.data\demo.db`.

## CLI

Build once:

```powershell
npm run build
```

Initialize a local database:

```powershell
node --no-warnings dist\cli.js init --db .data\agentic.db
```

Execute an Agent Intent:

```powershell
node --no-warnings dist\cli.js execute `
  --db .data\agentic.db `
  --file examples\put-product.json
```

Run a read-only human SQL query:

```powershell
node --no-warnings dist\cli.js sql `
  --db .data\agentic.db `
  --query "SELECT assertion_id, predicate, status FROM assertions"
```

Only `SELECT`, `EXPLAIN`, and schema-inspection PRAGMAs are accepted by
the SQL surface.

## Local HTTP API

```powershell
npm run serve
```

Default address: `http://127.0.0.1:4318`

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness |
| `GET /v1/catalog` | Operations and guarantees |
| `POST /v1/execute` | Execute one Agent Intent IR operation |

The development HTTP server is restricted to loopback and has no SQL route.
Use the CLI for local administrative SQL.

Example:

```powershell
$intent = Get-Content examples\put-product.json -Raw
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:4318/v1/execute `
  -ContentType application/json `
  -Body $intent
```

## MCP

Start the stdio server:

```powershell
npm run mcp
```

The server publishes `agentic-data://catalog` and these tools:

- `execute_intent`
- `search_knowledge`
- `resolve_claims`
- `reserve_inventory`
- `get_machine`

The three convenience read tools do not write audit receipts. Use
`execute_intent` when an otherwise read-only operation must produce a durable
receipt.

Generic local MCP configuration:

```json
{
  "command": "node",
  "args": [
    "--no-warnings",
    "D:\\Sites\\Mine\\AgenticData\\dist\\cli.js",
    "mcp",
    "--db",
    "D:\\Sites\\Mine\\AgenticData\\.data\\agentic.db"
  ]
}
```

## Agent Intent IR v0.1

Version 0.1 intentionally permits one operation per envelope:

```json
{
  "protocolVersion": "0.1",
  "requestId": "claim-1",
  "idempotencyKey": "claim-1",
  "principal": {
    "tenantId": "retail-demo",
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

Supported operations are available through the catalog endpoint and resource.

## Development architecture

```text
CLI / HTTP / MCP
        |
Agent Intent validation
        |
Agentic kernel
  | assertions + evidence
  | conflict resolution
  | hybrid retrieval
  | retail state machine
  | timers + effects + receipts
        |
replaceable storage boundary
        |
embedded SQLite
```

Important semantics:

- assertions are append-oriented and carry valid time plus system time;
- supersession closes the old assertion's system-time interval;
- observations, reported facts, inferences, predictions, decisions, and
  directives are distinct kinds;
- similarity scores remain separate from truth-strength fields;
- graph and hash-vector search generate candidates, not authority;
- inventory changes and state transitions commit in one transaction;
- timers and effects have deterministic identities;
- replay uses stable idempotency results.

## Development profile limitations

- single-process local database;
- caller-supplied local principal and tenant identity;
- deterministic feature-hash vectors demonstrate query plumbing but are not a
  semantic embedding model;
- retail workflow is a narrow reference state machine;
- SQLite is a development adapter.

## Production profile boundaries

- TLS terminates at a trusted reverse proxy or service mesh.
- The included rate limiter is process-local.
- The included deployment uses one PostgreSQL primary.
- The vector schema currently requires 1536-dimensional embeddings.
- External receivers must honor idempotency keys.
- Full projection epochs, operation DAGs, context-package optimization, and the
  complete benchmark campaign remain research milestones.

## Research

- [AGENT_FIRST_DATABASE_RESEARCH.md](AGENT_FIRST_DATABASE_RESEARCH.md)
- [PROOF_OF_CONCEPT_BLUEPRINT.md](PROOF_OF_CONCEPT_BLUEPRINT.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
