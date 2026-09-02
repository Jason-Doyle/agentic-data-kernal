# Explain and Trace

`explain` reconstructs the durable causal neighborhood around:

- an artifact;
- an assertion;
- a workflow revision;
- an effect.

Traversal follows typed lineage in both directions. Starting from the flagship
rollback effect, the graph includes its decision, governing directive,
originating workflow revision, supporting hypothesis, observations, source
artifacts, delivery attempts, and verification.

## Agent Intent

```json
{
  "op": "explain",
  "target": {
    "type": "effect",
    "effectId": "effect_..."
  },
  "maxDepth": 4
}
```

Workflow revisions use:

```json
{
  "type": "workflow_revision",
  "instanceId": "incident:1001",
  "revision": 3
}
```

The result contains:

```text
root
maxDepth
truncated
nodes[]  -> typed reference, depth, label, sanitized record
edges[]  -> source, relation, target, creator, timestamp
```

Effect nodes include delivery and reconciliation attempts. Artifact nodes expose
metadata and content hashes but never artifact plaintext.

## CLI

Development profile:

```powershell
agentic-data explain `
  --db .data\agentic.db `
  --tenant example `
  --type effect `
  --id effect_...
```

Production profile:

```powershell
agentic-data-prod explain `
  --type effect `
  --id effect_...
```

The production command uses `AGENTIC_DATA_API_KEY` and
`AGENTIC_DATA_PURPOSE`. Add `--json` for the structured result or `--depth N`
to select a traversal depth from 0 through 8.

## MCP

Both profiles expose the read-only `explain_trace` tool. Production identity is
bound to the authenticated MCP process, so callers cannot supply a tenant.

## HTTP and TypeScript

HTTP clients submit the `explain` operation through `POST /v1/execute`.

TypeScript:

```ts
const explanation = await kernel.explainReadOnly(
  principal,
  { type: "effect", effectId },
  4,
);
```

The embedded kernel provides synchronous `kernel.explain(...)`.

## Limits

- Maximum requested depth: 8
- Maximum returned nodes: 500
- Maximum returned edges: 2000
- Maximum returned attempts per effect: 20, preserving the first and last 10

`truncated` is true when a bound is reached.

The graph explains explicitly persisted lineage. It does not infer missing
causal links from semantic similarity or freeform text.
