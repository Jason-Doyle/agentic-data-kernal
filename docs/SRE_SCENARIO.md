# Flagship SRE Scenario

The flagship scenario is a deterministic production-profile incident:

```text
alert
  -> observations
  -> competing hypotheses
  -> confidence updates
  -> explicit resolution
  -> decision and policy
  -> authorized rollback
  -> unknown delivery outcome
  -> agent restart
  -> provider reconciliation
  -> verification
  -> resolved incident
```

It is intentionally messy enough to exercise the kernel rather than only show
a successful API call.

## What happens

1. Monitoring reports a checkout error rate of 42 percent.
2. Deployment history shows `api-v42` was released three minutes earlier.
3. Database CPU increased by 12 percent, creating a competing saturation
   hypothesis.
4. The agent stores both hypotheses and later supersedes them with revised
   probabilities of 0.88 and 0.12.
5. `highest_authority` resolution selects the deployment hypothesis while
   preserving the conflict.
6. A decision assertion selects rollback under
   `incident-remediation-v2`.
7. The incident workflow advances to `remediation_pending`.
8. A policy-bound `deployment.rollback` effect is created.
9. The first runtime closes.
10. A new worker runtime applies the rollback but receives no usable response,
    so the effect becomes `reconciling`.
11. A third runtime retries the logical request. Provider-level idempotency
    returns the original effect rather than reserving or delivering again.
12. Provider status reconciliation proves the rollback succeeded.
13. Monitoring reports a 3 percent error rate and supersedes the original
    observation.
14. The effect is linked to that verification observation.
15. The incident becomes terminal as `resolved`.

The final invariant is:

```text
deliveryCount = 1
reconciliationCount = 1
effectStatus = succeeded
workflowState = resolved
```

## Run

Use a dedicated empty database, prepare `.env` as described in
[Production Profile](PRODUCTION.md), then start PostgreSQL and create the
restricted runtime role:

```powershell
docker compose up -d postgres
docker compose run --rm bootstrap
npm run build
npm run example:sre
```

`SRE_RUN_ID` is optional. Omit it for a unique run or set a new safe identifier:

```powershell
$env:SRE_RUN_ID = "incident-1001"
npm run example:sre
```

The scenario configures the database with the explicit synthetic embedding
space `agentic-data-sre-synthetic/1/384`, creates its own tenant and API key,
and never prints the token. It leaves completed records in PostgreSQL for
inspection. Migration rejects running it in a non-empty database configured
for another embedding space.

Example result:

```json
{
  "finalState": "resolved",
  "terminal": true,
  "effectStatus": "succeeded",
  "resolutionStatus": "resolved_with_conflict",
  "deliveryCount": 1,
  "reconciliationCount": 1,
  "agentRestarts": 2,
  "errorRateBefore": 0.42,
  "errorRateAfter": 0.03
}
```

## Durable records

The run persists:

- source artifacts and observations;
- both initial and revised hypotheses;
- conflict-preserving resolution receipts;
- decision and directive assertions;
- five workflow revisions;
- one external effect with two attempts;
- provider idempotency and authorization data;
- typed causal lineage;
- a superseding verification observation.

## Boundaries

The telemetry, embeddings, and deployment provider are deterministic synthetic
adapters. The scenario proves persistence, authorization, lineage, restart,
idempotency, reconciliation, and verification behavior. It does not claim
production incident-detection quality or benchmark superiority over another
stack.
