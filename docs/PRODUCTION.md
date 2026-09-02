# Production Profile

## Architecture

```text
TLS proxy or service mesh
          |
authenticated HTTP or MCP
          |
production kernel
  | scope and purpose checks
  | PostgreSQL tenant transaction
  | real embedding provider
  | encrypted artifact store
  | receipts and idempotency
          |
PostgreSQL 18 + pgvector
          |
separate effect worker
          |
allowlisted HTTPS receivers
```

The runtime role is `agentic_app`. It is not a superuser and does not have
`BYPASSRLS`. Migrations run separately as the PostgreSQL administrator.

## Initial setup

Generate local secrets:

```powershell
.\scripts\generate-secrets.ps1
```

Copy `.env.example` to `.env`, replace every placeholder, and configure an
OpenAI-compatible 1536-dimensional embeddings endpoint.

The `prod:*` npm scripts load `.env` through Node's `--env-file` option.

Start PostgreSQL and create the restricted role:

```powershell
docker compose up -d postgres
docker compose run --rm bootstrap
```

Apply migrations with the administrative connection:

```powershell
npm run prod:migrate
```

Create an API key:

```powershell
node --env-file=.env dist\production\cli.js create-key `
  --tenant example `
  --tenant-name "Example" `
  --principal catalog-agent `
  --scopes data:read,data:write,inventory:admin,orders:write,effects:write `
  --purposes catalog-ingestion,checkout `
  --effect-currency USD `
  --effect-budget 1000
```

The token is shown once. Store it in a secret manager.

## Run

Run the HTTP service and effect worker together:

```powershell
docker compose --profile server up --build
```

The Compose profile publishes only the Caddy TLS endpoint at
`https://localhost:8443`. The Node.js service remains private on the Compose
network. Caddy uses its internal CA for the local profile. Trust or replace that
CA according to your environment before connecting clients.

The `artifact-init` service creates the bind-mounted artifact directory and
assigns it to the non-root application UID before the app and worker start.

Or run them directly:

```powershell
npm run prod:serve
npm run prod:worker
```

## HTTP authentication

Every production API request except liveness, readiness, and metrics requires:

```text
Authorization: Bearer adk.<key-id>.<secret>
X-Agent-Purpose: approved-purpose
```

The intent envelope must contain the same tenant, principal, and purpose as the
authenticated key. A mismatch is rejected.

Production routes, through the TLS proxy:

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /health/live` | No | Process liveness |
| `GET /health/ready` | No | Database and migration readiness |
| `GET /metrics` | No | Prometheus text metrics |
| `GET /v1/catalog` | Yes | Production capabilities |
| `POST /v1/execute` | Yes | One scoped Agent Intent operation |

There is no production SQL route.

## MCP

Set:

```text
AGENTIC_DATA_API_KEY
AGENTIC_DATA_PURPOSE
```

Then run:

```powershell
npm run prod:mcp
```

The MCP process authenticates once and does not accept caller-supplied tenant or
principal identities.

## Encrypted artifacts

`ARTIFACT_KEYRING` is a JSON object whose values are base64-encoded 32-byte
keys:

```json
{"v1":"base64-key","v2":"base64-key"}
```

`ARTIFACT_CURRENT_KEY_ID` selects the key for new writes. Keep old keys in the
ring until every artifact using them has expired, been deleted, or been
reencrypted.

Artifact files use:

- a random 96-bit nonce;
- AES-256-GCM;
- tenant-derived keys using HKDF-SHA256;
- authenticated metadata binding tenant, artifact ID, media type, and content
  hash;
- atomic temporary-file creation and rename;
- immutable content-address verification.

Artifact metadata writes are serialized with a database advisory lock. A failed
or interrupted request can leave encrypted ciphertext without metadata. This is
safer than deleting a file another concurrent transaction may reference. An
administrator removes aged orphan files with:

```powershell
node --env-file=.env dist\production\cli.js reconcile-artifacts
```

Reconciliation requires `MIGRATION_DATABASE_URL` and refuses an RLS-restricted
runtime connection.

## Embeddings

The production profile calls:

```text
POST <EMBEDDING_BASE_URL>/embeddings
```

It sends the configured model, input list, and 1536 dimensions. Provider errors,
timeouts, invalid result counts, and dimension mismatches fail the operation.
There is no hash-vector fallback.

Artifact plaintext may be sent to the configured provider when an assertion
uses that artifact as evidence. Use an approved private endpoint when the data
must not leave your environment.

## Effects and reconciliation

An effect is created only when:

- the API key has `effects:write`;
- the request purpose is approved;
- the key is active and unexpired;
- the effect amount fits within the remaining budget;
- the target uses HTTPS and its host is allowlisted.

Money values use canonical decimal strings with at most four decimal places.
The API key budget and payment amount must use the same three-letter currency.

Payment requests also provide a provider status URL. After normal delivery
attempts are exhausted, the worker continues status reconciliation rather than
stranding the order and reserved budget.

The worker acquires a database lease and authorization fence while locking the
authorizing key. Revocation that commits before this fence cancels the effect.
Once the fence is committed, retries are permitted only with the same effect ID
and idempotency key because the remote side may already have acted.

The worker rejects private and reserved DNS results, pins the connection to the
validated address, retains TLS verification for the original hostname, and
disables redirects.
Timeouts, retryable responses, and ambiguous acknowledgements become `unknown`.
They are retried with the same idempotency key up to
`EFFECT_MAX_ATTEMPTS`. A receiver must return a stable `providerReference` for
success.

Public clients cannot submit payment outcomes.

## Backup and restore

Create a checksum-manifested backup:

```powershell
docker compose --profile server stop app worker
.\scripts\backup.ps1
```

Restore after stopping application and worker processes:

```powershell
.\scripts\restore.ps1 `
  -BackupDirectory .backups\<timestamp> `
  -ConfirmRestore
```

The database and encrypted artifacts are one recovery unit. Backup and restore
set a database maintenance flag that every supported writer checks while
holding a transaction lock. The scripts also refuse running Compose app or
worker containers.

## Load smoke test

```powershell
npm run prod:load -- `
  --url https://localhost:8443 `
  --tenant example `
  --principal load-agent `
  --purpose load-test `
  --requests 1000 `
  --concurrency 25
```

The harness reports success count, requests per second, and p50, p95, and p99
latency. It is a smoke tool, not a substitute for the benchmark program in
`PROOF_OF_CONCEPT_BLUEPRINT.md`.

## Operational checklist

1. Apply migrations through the administrator connection.
2. Verify `/health/ready`.
3. Confirm the runtime database role is not a superuser and has no
   `BYPASSRLS`.
4. Test two-tenant isolation.
5. Confirm artifact files do not contain plaintext.
6. Verify the embedding endpoint and dimension.
7. Configure effect allowlists and budgets.
8. Start the effect worker.
9. Capture `/metrics` and structured logs.
10. Run a backup and restore drill.
11. Run the authenticated load smoke test.
12. Review `SECURITY.md` before exposing the service.
