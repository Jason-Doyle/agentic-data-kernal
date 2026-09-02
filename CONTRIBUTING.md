# Contributing

## Local setup

```powershell
npm install
npm run check
npm test
```

## Design rules

- Preserve the distinction between authoritative records and epistemic
  assertions.
- Keep retrieval scores separate from truth or confidence semantics.
- Make every mutation idempotent or explicitly non-retryable.
- Keep timers, effects, and state transitions deterministic and replayable.
- Enforce tenant identity at the storage boundary when adding shared or remote
  adapters.
- Add an invariant or failure-path test for every consequential state change.
- Do not add a new storage engine or index without a benchmark demonstrating
  the need.

## Pull requests

Keep changes focused and include:

- the behavior being added or corrected;
- tests for normal, retry, and failure paths;
- any change to the Agent Intent or persistence contract;
- migration and compatibility notes when stored data changes.
