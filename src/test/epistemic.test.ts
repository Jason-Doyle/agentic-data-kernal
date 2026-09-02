import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgenticKernel } from "../kernel.js";
import { SqliteStore } from "../store.js";

test("claims preserve conflicts and bitemporal revision", () => {
  let current = new Date("2026-01-01T00:00:00.000Z");
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store, () => new Date(current));
  const principal = {
    tenantId: "tenant-a",
    principalId: "tester",
    purpose: "test",
  };

  kernel.putEntity(principal, {
    entityId: "product:1",
    entityType: "product",
    canonicalName: "Product One",
  });
  kernel.assert(principal, {
    assertionId: "weight-a",
    subjectEntityId: "product:1",
    predicate: "weight",
    object: { type: "number", value: 4.8, unit: "kg" },
    kind: "reported_fact",
    authority: 70,
  });
  kernel.assert(principal, {
    assertionId: "weight-b",
    subjectEntityId: "product:1",
    predicate: "weight",
    object: { type: "number", value: 5.1, unit: "kg" },
    kind: "reported_fact",
    authority: 60,
  });

  const conflict = kernel.resolve("tenant-a", "product:1", "weight");
  assert.equal(conflict.status, "conflicted");
  assert.equal(conflict.candidates.length, 2);

  const oldLocation = kernel.assert(principal, {
    assertionId: "location-old",
    subjectEntityId: "product:1",
    predicate: "warehouse",
    object: { type: "string", value: "Dublin" },
    kind: "reported_fact",
    validFrom: "2025-01-01T00:00:00.000Z",
  });
  const historicalSystemTime = oldLocation.systemFrom;
  current = new Date("2026-02-01T00:00:00.000Z");
  kernel.assert(principal, {
    assertionId: "location-new",
    subjectEntityId: "product:1",
    predicate: "warehouse",
    object: { type: "string", value: "Seattle" },
    kind: "reported_fact",
    validFrom: "2026-02-01T00:00:00.000Z",
    supersedesAssertionId: "location-old",
  });

  const historical = kernel.resolve(
    "tenant-a",
    "product:1",
    "warehouse",
    "none",
    {
      systemAt: historicalSystemTime,
      validAt: "2026-01-15T00:00:00.000Z",
    },
  );
  assert.equal(historical.status, "known");
  assert.equal(historical.selected?.status, "active");
  assert.deepEqual(historical.selected?.object, {
    type: "string",
    value: "Dublin",
  });

  const currentValue = kernel.resolve(
    "tenant-a",
    "product:1",
    "warehouse",
  );
  assert.equal(currentValue.status, "known");
  assert.deepEqual(currentValue.selected?.object, {
    type: "string",
    value: "Seattle",
  });

  store.close();
});

test("offset timestamps normalize and same-millisecond supersession succeeds", () => {
  const fixed = new Date("2026-01-01T00:00:00.000Z");
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store, () => new Date(fixed));
  const principal = {
    tenantId: "tenant-a",
    principalId: "tester",
    purpose: "test",
  };
  kernel.putEntity(principal, {
    entityId: "asset:1",
    entityType: "asset",
    canonicalName: "Asset One",
  });
  const first = kernel.assert(principal, {
    assertionId: "state-old",
    subjectEntityId: "asset:1",
    predicate: "state",
    object: { type: "string", value: "old" },
    kind: "reported_fact",
    validFrom: "2026-01-01T00:00:00+02:00",
  });
  const second = kernel.assert(principal, {
    assertionId: "state-new",
    subjectEntityId: "asset:1",
    predicate: "state",
    object: { type: "string", value: "new" },
    kind: "reported_fact",
    validFrom: "2025-12-31T22:30:00Z",
    supersedesAssertionId: first.assertionId,
  });
  assert.ok(second.systemFrom > first.systemFrom);

  const historical = kernel.resolve(
    "tenant-a",
    "asset:1",
    "state",
    "none",
    {
      systemAt: first.systemFrom,
      validAt: "2025-12-31T17:15:00-05:00",
    },
  );
  assert.equal(historical.status, "known");
  assert.deepEqual(historical.selected?.object, {
    type: "string",
    value: "old",
  });
  assert.equal(historical.selected?.status, "active");
  store.close();
});

test("conflict resolution examines more than 500 applicable claims", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  const principal = {
    tenantId: "tenant-a",
    principalId: "tester",
    purpose: "test",
  };
  kernel.putEntity(principal, {
    entityId: "metric:1",
    entityType: "metric",
    canonicalName: "Metric One",
  });
  for (let index = 0; index < 501; index += 1) {
    kernel.assert(principal, {
      assertionId: `metric-same-${index}`,
      subjectEntityId: "metric:1",
      predicate: "value",
      object: { type: "number", value: 1 },
      kind: "reported_fact",
      authority: 100 - (index % 100),
    });
  }
  kernel.assert(principal, {
    assertionId: "metric-conflict",
    subjectEntityId: "metric:1",
    predicate: "value",
    object: { type: "number", value: 2 },
    kind: "reported_fact",
    authority: 0,
  });
  const resolution = kernel.resolve("tenant-a", "metric:1", "value");
  assert.equal(resolution.status, "conflicted");
  assert.equal(resolution.candidates.length, 502);
  store.close();
});

test("logical system time remains monotonic across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-data-clock-"));
  const databasePath = join(directory, "clock.db");
  const principal = {
    tenantId: "tenant-a",
    principalId: "tester",
    purpose: "test",
  };
  try {
    const firstStore = new SqliteStore(databasePath);
    const firstKernel = new AgenticKernel(
      firstStore,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    firstKernel.putEntity(principal, {
      entityId: "asset:restart",
      entityType: "asset",
      canonicalName: "Restarted Asset",
    });
    const first = firstKernel.assert(principal, {
      assertionId: "restart-old",
      subjectEntityId: "asset:restart",
      predicate: "state",
      object: { type: "string", value: "old" },
      kind: "reported_fact",
    });
    firstStore.close();

    const secondStore = new SqliteStore(databasePath);
    const secondKernel = new AgenticKernel(
      secondStore,
      () => new Date("2025-01-01T00:00:00.000Z"),
    );
    const second = secondKernel.assert(principal, {
      assertionId: "restart-new",
      subjectEntityId: "asset:restart",
      predicate: "state",
      object: { type: "string", value: "new" },
      kind: "reported_fact",
      supersedesAssertionId: first.assertionId,
    });
    assert.ok(second.systemFrom > first.systemFrom);
    secondStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hybrid search can apply graph distance", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  const principal = {
    tenantId: "tenant-a",
    principalId: "tester",
    purpose: "test",
  };
  for (const [entityId, type, name] of [
    ["customer:1", "customer", "Customer One"],
    ["incident:1", "incident", "Checkout incident"],
  ] as const) {
    kernel.putEntity(principal, {
      entityId,
      entityType: type,
      canonicalName: name,
    });
  }
  kernel.assert(principal, {
    subjectEntityId: "incident:1",
    predicate: "affected_customer",
    object: { type: "entity", value: "customer:1" },
    kind: "observation",
  });
  kernel.assert(principal, {
    subjectEntityId: "incident:1",
    predicate: "summary",
    object: {
      type: "string",
      value: "Severe pricing checkout performance degradation",
    },
    kind: "observation",
  });

  const hits = kernel.search("tenant-a", {
    text: "pricing performance degradation",
    relatedToEntityId: "customer:1",
    maxGraphDepth: 2,
  });
  assert.ok(hits.length > 0);
  assert.equal(hits[0]?.assertion.subjectEntityId, "incident:1");
  assert.equal(hits[0]?.graphDistance, 1);
  store.close();
});

test("artifacts are immutable by identifier", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  const principal = {
    tenantId: "tenant-a",
    principalId: "tester",
    purpose: "test",
  };
  kernel.putArtifact(principal, {
    artifactId: "artifact:1",
    mediaType: "text/plain",
    content: "original",
    sourceIdentity: "source-a",
  });
  assert.throws(
    () =>
      kernel.putArtifact(principal, {
        artifactId: "artifact:1",
        mediaType: "text/plain",
        content: "changed",
        sourceIdentity: "source-a",
      }),
    /immutable/,
  );
  store.close();
});
