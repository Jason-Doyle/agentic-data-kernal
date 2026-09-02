import assert from "node:assert/strict";
import test from "node:test";
import { AgenticKernel } from "../kernel.js";
import { SqliteStore } from "../store.js";

test("retail order reserves, requests payment, and commits once", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  const principal = {
    tenantId: "retail",
    principalId: "checkout",
    purpose: "checkout",
  };

  kernel.seedInventory(principal, "sku-1", "store-1", 5);
  const first = kernel.reserveInventory(principal, {
    orderId: "order-1",
    sku: "sku-1",
    location: "store-1",
    quantity: 2,
    holdSeconds: 600,
    idempotencyKey: "reserve-order-1",
  });
  const replay = kernel.reserveInventory(principal, {
    orderId: "order-1",
    sku: "sku-1",
    location: "store-1",
    quantity: 2,
    holdSeconds: 600,
    idempotencyKey: "reserve-order-1",
  });
  assert.deepEqual(replay, first);
  assert.equal(
    kernel.getInventory("retail", "sku-1", "store-1").quantityReserved,
    2,
  );

  const effect = kernel.requestPayment(principal, {
    instanceId: "order:order-1",
    amount: 20,
    currency: "USD",
    paymentTarget: "test-payments",
    idempotencyKey: "pay-order-1",
  });
  assert.equal(effect.status, "planned");

  const confirmed = kernel.recordPaymentOutcome(principal, {
    effectId: effect.effectId,
    idempotencyKey: "payment-outcome-1",
    status: "succeeded",
    outcome: { providerReference: "payment-1" },
  });
  assert.equal(confirmed.state, "confirmed");
  const inventory = kernel.getInventory("retail", "sku-1", "store-1");
  assert.equal(inventory.quantityOnHand, 3);
  assert.equal(inventory.quantityReserved, 0);

  const repeated = kernel.recordPaymentOutcome(principal, {
    effectId: effect.effectId,
    idempotencyKey: "payment-outcome-1",
    status: "succeeded",
    outcome: { providerReference: "payment-1" },
  });
  assert.equal(repeated.revision, confirmed.revision);
  assert.equal(
    kernel.getInventory("retail", "sku-1", "store-1").quantityOnHand,
    3,
  );
  store.close();
});

test("expired reservations release inventory", () => {
  let current = new Date("2026-01-01T00:00:00.000Z");
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store, () => new Date(current));
  const principal = {
    tenantId: "retail",
    principalId: "checkout",
    purpose: "checkout",
  };
  kernel.seedInventory(principal, "sku-1", "store-1", 5);
  kernel.reserveInventory(principal, {
    orderId: "order-2",
    sku: "sku-1",
    location: "store-1",
    quantity: 2,
    holdSeconds: 60,
    idempotencyKey: "reserve-order-2",
  });
  current = new Date("2026-01-01T00:02:00.000Z");
  const changed = kernel.processDueTimers(principal);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.state, "cancelled");
  assert.equal(
    kernel.getInventory("retail", "sku-1", "store-1").quantityReserved,
    0,
  );
  store.close();
});

test("unknown payment callbacks are idempotent and can later reconcile", () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  const principal = {
    tenantId: "retail",
    principalId: "checkout",
    purpose: "checkout",
  };
  kernel.seedInventory(principal, "sku-2", "store-1", 4);
  kernel.reserveInventory(principal, {
    orderId: "order-3",
    sku: "sku-2",
    location: "store-1",
    quantity: 1,
    holdSeconds: 600,
    idempotencyKey: "reserve-order-3",
  });
  const effect = kernel.requestPayment(principal, {
    instanceId: "order:order-3",
    amount: 10,
    currency: "USD",
    paymentTarget: "test-payments",
    idempotencyKey: "pay-order-3",
  });
  const unknown = kernel.recordPaymentOutcome(principal, {
    effectId: effect.effectId,
    idempotencyKey: "callback-unknown-1",
    status: "unknown",
  });
  const replay = kernel.recordPaymentOutcome(principal, {
    effectId: effect.effectId,
    idempotencyKey: "callback-unknown-1",
    status: "unknown",
  });
  assert.equal(replay.revision, unknown.revision);

  const confirmed = kernel.recordPaymentOutcome(principal, {
    effectId: effect.effectId,
    idempotencyKey: "callback-success-1",
    status: "succeeded",
  });
  assert.equal(confirmed.state, "confirmed");
  assert.equal(
    kernel.getInventory("retail", "sku-2", "store-1").quantityOnHand,
    3,
  );
  store.close();
});

test("payment cannot start after the reservation expires", () => {
  let current = new Date("2026-01-01T00:00:00.000Z");
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store, () => new Date(current));
  const principal = {
    tenantId: "retail",
    principalId: "checkout",
    purpose: "checkout",
  };
  kernel.seedInventory(principal, "sku-3", "store-1", 2);
  kernel.reserveInventory(principal, {
    orderId: "order-4",
    sku: "sku-3",
    location: "store-1",
    quantity: 1,
    holdSeconds: 60,
    idempotencyKey: "reserve-order-4",
  });
  current = new Date("2026-01-01T00:02:00.000Z");
  assert.throws(
    () =>
      kernel.requestPayment(principal, {
        instanceId: "order:order-4",
        amount: 10,
        currency: "USD",
        paymentTarget: "test-payments",
        idempotencyKey: "pay-order-4",
      }),
    /reservation has expired/,
  );
  const changed = kernel.processDueTimers(
    principal,
    "2025-12-31T19:02:00-05:00",
  );
  assert.equal(changed[0]?.state, "cancelled");
  assert.equal(
    kernel.getInventory("retail", "sku-3", "store-1").quantityReserved,
    0,
  );
  store.close();
});
