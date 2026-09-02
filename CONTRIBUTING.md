# Contributing

## Local setup

```powershell
npm install
npm run check
npm test
```

For PostgreSQL changes, also run the integration suite described in
[docs/PRODUCTION.md](docs/PRODUCTION.md).

## Design rules

- Preserve the distinction between authoritative records and epistemic
  assertions.
- Keep retrieval scores separate from truth or confidence semantics.
- Make every mutation idempotent or explicitly non-retryable.
- Keep timers, effects, and state transitions deterministic and replayable.
- Keep causal lineage tenant-scoped, typed, and backed by durable record IDs.
- Do not let generic workflow operations bypass reserved domain invariants.
- Enforce tenant identity at the storage boundary when adding shared or remote
  adapters.
- Add an invariant or failure-path test for every consequential state change.
- Do not add a new storage engine or index without a benchmark demonstrating
  the need.
- Keep public examples runnable and update `docs/API.md` when operation
  contracts change.
- Never commit credentials, private artifacts, generated databases, or backup
  files.

## Pull requests

Keep changes focused and include:

- the behavior being added or corrected;
- tests for normal, retry, and failure paths;
- any change to the Agent Intent or persistence contract;
- migration and compatibility notes when stored data changes.

## Documentation

Use current behavior and direct language. Clearly label extension points and
planned capabilities. Keep README examples short and move detailed integration
steps into `docs`.

## Releases

Releases are built from version tags after the corresponding pull request has
merged to `main`. See [docs/RELEASING.md](docs/RELEASING.md) for the version,
package, container, and registry process.
