import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVELOPMENT_OPERATION_NAMES,
  operationLayer,
  operationLayerCatalog,
  PRODUCTION_OPERATION_NAMES,
  RetailCompatibilityAdapter,
} from "../layers.js";
import { AgenticKernel } from "../kernel.js";
import { productionCatalog } from "../production/catalog.js";
import { SqliteStore } from "../store.js";
import type { PrincipalContext } from "../types.js";

const principal: PrincipalContext = {
  tenantId: "layer-tenant",
  principalId: "layer-agent",
  purpose: "layer-test",
};

test("operation layers classify every compatible Agent Intent operation", () => {
  assert.deepEqual(DEVELOPMENT_OPERATION_NAMES, [
    "put_entity",
    "put_artifact",
    "assert",
    "resolve",
    "search",
    "create_workflow",
    "advance_workflow",
    "request_effect",
    "add_lineage",
    "explain",
    "record_effect_outcome",
    "seed_inventory",
    "reserve_inventory",
    "request_payment",
    "record_payment_outcome",
    "get_machine",
    "list_effects",
    "process_timers",
  ]);
  assert.equal(
    new Set(DEVELOPMENT_OPERATION_NAMES).size,
    DEVELOPMENT_OPERATION_NAMES.length,
  );
  assert.equal(operationLayer("assert"), "knowledge");
  assert.equal(operationLayer("request_effect"), "agency");
  assert.equal(operationLayer("process_timers"), "retail_compatibility");
  assert.throws(
    () =>
      operationLayer(
        "unknown_operation" as (typeof DEVELOPMENT_OPERATION_NAMES)[number],
      ),
    /Unknown Agent Intent operation/,
  );
  assert.deepEqual(
    operationLayerCatalog(DEVELOPMENT_OPERATION_NAMES),
    {
      knowledge: [
        "put_entity",
        "put_artifact",
        "assert",
        "resolve",
        "search",
        "add_lineage",
        "explain",
      ],
      agency: [
        "create_workflow",
        "advance_workflow",
        "request_effect",
        "record_effect_outcome",
        "get_machine",
        "list_effects",
      ],
      retailCompatibility: [
        "seed_inventory",
        "reserve_inventory",
        "request_payment",
        "record_payment_outcome",
        "process_timers",
      ],
    },
  );
});

test("embedded layers provide preferred APIs without removing legacy methods", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  try {
    assert.ok(kernel.retail instanceof RetailCompatibilityAdapter);
    kernel.knowledge.putEntity(principal, {
      entityId: "service:checkout",
      entityType: "service",
      canonicalName: "Checkout",
    });
    kernel.knowledge.assert(principal, {
      assertionId: "assertion:healthy",
      subjectEntityId: "service:checkout",
      predicate: "healthy",
      object: { type: "boolean", value: true },
      kind: "observation",
    });
    assert.equal(
      kernel.knowledge.resolve(
        principal.tenantId,
        "service:checkout",
        "healthy",
      ).status,
      "known",
    );

    const workflow = kernel.agency.createWorkflow(principal, {
      instanceId: "incident:layers",
      workflowType: "incident_response",
      initialState: "open",
      data: { severity: 3 },
    });
    assert.deepEqual(
      kernel.getWorkflow(principal.tenantId, workflow.instanceId),
      workflow,
    );

    const inventory = kernel.retail.seedInventory(
      principal,
      "camera",
      "store",
      2,
    );
    assert.deepEqual(
      kernel.getInventory(principal.tenantId, "camera", "store"),
      inventory,
    );
    const reservation = kernel.retail.reserveInventory(principal, {
      orderId: "layer-order",
      sku: "camera",
      location: "store",
      quantity: 1,
      holdSeconds: 600,
      idempotencyKey: "layer-order",
    });
    assert.equal(
      kernel.getMachine(
        principal.tenantId,
        reservation.machine.instanceId,
      ).state,
      "reserved",
    );
  } finally {
    store.close();
  }
});

test("catalogs expose profile-specific operation layers", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  try {
    const development = kernel.catalog();
    assert.deepEqual(
      development.operations,
      DEVELOPMENT_OPERATION_NAMES,
    );
    assert.deepEqual(
      development.operationLayers,
      operationLayerCatalog(DEVELOPMENT_OPERATION_NAMES),
    );
  } finally {
    store.close();
  }

  const production = productionCatalog();
  assert.deepEqual(production.operations, PRODUCTION_OPERATION_NAMES);
  assert.deepEqual(
    production.operationLayers,
    operationLayerCatalog(PRODUCTION_OPERATION_NAMES),
  );
  assert.equal(
    production.operationLayers.agency.includes(
      "record_effect_outcome",
    ),
    false,
  );
  assert.equal(
    production.operationLayers.retailCompatibility.includes(
      "record_payment_outcome",
    ),
    false,
  );
});
