import type { CatalogDescription } from "../types.js";

export function productionCatalog(): CatalogDescription & {
  profile: "postgres-production";
  security: string[];
} {
  return {
    protocolVersion: "0.1",
    profile: "postgres-production",
    storage: "PostgreSQL 18 with pgvector and forced tenant row-level security",
    operations: [
      "put_entity",
      "put_artifact",
      "assert",
      "resolve",
      "search",
      "seed_inventory",
      "reserve_inventory",
      "request_payment",
      "get_machine",
      "list_effects",
      "process_timers",
    ],
    epistemicKinds: [
      "observation",
      "reported_fact",
      "inference",
      "prediction",
      "hypothesis",
      "decision",
      "directive",
      "experience",
    ],
    strengthTypes: [
      "none",
      "rank",
      "probability",
      "interval",
      "evidence_count",
    ],
    machineStates: [
      "new",
      "reserved",
      "payment_pending",
      "confirmed",
      "cancelled",
      "failed",
    ],
    guarantees: [
      "server-authenticated principal and purpose",
      "forced tenant row-level security",
      "checksum-verified forward migrations",
      "encrypted immutable artifact storage",
      "real provider embeddings with no silent fallback",
      "transactional inventory and durable workflow state",
      "effect budgets and dispatch authorization fences",
      "idempotent effect delivery and unknown-outcome reconciliation",
    ],
    security: [
      "Bearer API keys are stored as peppered HMAC hashes",
      "raw SQL is not exposed over the production network API",
      "effect targets require HTTPS, an allowlisted host, and public DNS",
      "payment outcomes cannot be asserted through the public intent API",
    ],
    limitations: [
      "single PostgreSQL primary",
      "1536-dimensional embedding schema",
      "one operation per Agent IR v0.1 envelope",
      "TLS termination is expected at a trusted reverse proxy",
    ],
  };
}
