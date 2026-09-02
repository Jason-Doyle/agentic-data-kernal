export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type EpistemicKind =
  | "observation"
  | "reported_fact"
  | "inference"
  | "prediction"
  | "hypothesis"
  | "decision"
  | "directive"
  | "experience";

export type AssertionStatus =
  | "active"
  | "disputed"
  | "superseded"
  | "expired"
  | "quarantined"
  | "deleted";

export type Strength =
  | { type: "none" }
  | { type: "rank"; value: "preferred" | "normal" | "deprecated" }
  | {
      type: "probability";
      value: number;
      calibrationRef?: string;
      eventDefinition?: string;
    }
  | { type: "interval"; low: number; high: number; method: string }
  | {
      type: "evidence_count";
      supporting: number;
      considered: number;
    };

export type TypedValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number; unit?: string }
  | { type: "boolean"; value: boolean }
  | { type: "timestamp"; value: string }
  | { type: "entity"; value: string }
  | { type: "json"; value: JsonValue };

export interface PrincipalContext {
  tenantId: string;
  principalId: string;
  purpose: string;
}

export interface EntityInput {
  entityId: string;
  entityType: string;
  canonicalName: string;
}

export interface EntityRecord extends EntityInput {
  tenantId: string;
  createdAt: string;
}

export interface ArtifactInput {
  artifactId?: string;
  mediaType: string;
  content: string;
  sourceIdentity: string;
  observedAt?: string;
  sensitivity?: string;
  retentionPolicy?: string;
}

export interface ArtifactRecord {
  tenantId: string;
  artifactId: string;
  contentHash: string;
  mediaType: string;
  content: string;
  sourceIdentity: string;
  observedAt: string;
  sensitivity: string;
  retentionPolicy: string;
  status: "active" | "deleted";
  createdAt: string;
}

export interface AssertionInput {
  assertionId?: string;
  subjectEntityId: string;
  predicate: string;
  object: TypedValue;
  kind: EpistemicKind;
  perspective?: string;
  validFrom?: string;
  validTo?: string;
  strength?: Strength;
  authority?: number;
  status?: "active" | "disputed";
  sourceArtifactId?: string;
  basis?: JsonValue;
  supersedesAssertionId?: string;
}

export interface AssertionRecord {
  tenantId: string;
  assertionId: string;
  subjectEntityId: string;
  predicate: string;
  object: TypedValue;
  kind: EpistemicKind;
  perspective: string;
  validFrom: string;
  validTo: string | null;
  systemFrom: string;
  systemTo: string | null;
  strength: Strength;
  authority: number;
  status: AssertionStatus;
  sourceArtifactId: string | null;
  basis: JsonValue | null;
  supersedesAssertionId: string | null;
  createdBy: string;
}

export interface AssertionQuery {
  subjectEntityId?: string;
  predicate?: string;
  kind?: EpistemicKind;
  perspective?: string;
  validAt?: string;
  systemAt?: string;
  limit?: number;
}

export type ResolutionPolicy = "none" | "latest" | "highest_authority";

export interface ResolutionResult {
  status: "known" | "unknown" | "conflicted" | "resolved_with_conflict";
  selected: AssertionRecord | null;
  candidates: AssertionRecord[];
  conflicts: AssertionRecord[];
  policy: ResolutionPolicy;
  validAt: string;
  systemAt: string;
}

export interface SearchQuery {
  text: string;
  predicate?: string;
  kind?: EpistemicKind;
  perspective?: string;
  relatedToEntityId?: string;
  maxGraphDepth?: number;
  validAt?: string;
  systemAt?: string;
  limit?: number;
}

export interface SearchHit {
  assertion: AssertionRecord;
  lexicalScore: number;
  vectorScore: number;
  combinedScore: number;
  graphDistance: number | null;
}

export interface InventoryRecord {
  tenantId: string;
  sku: string;
  location: string;
  quantityOnHand: number;
  quantityReserved: number;
  version: number;
  updatedAt: string;
}

export type MachineState =
  | "new"
  | "reserved"
  | "payment_pending"
  | "confirmed"
  | "cancelled"
  | "failed";

export interface OrderData {
  orderId: string;
  sku: string;
  location: string;
  quantity: number;
  reservationExpiresAt: string;
}

export interface MachineRecord {
  tenantId: string;
  instanceId: string;
  machineType: "retail_order";
  state: MachineState;
  data: OrderData;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type EffectStatus =
  | "planned"
  | "dispatching"
  | "reconciling"
  | "unknown"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface EffectRecord {
  tenantId: string;
  effectId: string;
  instanceId: string;
  originatingRevision: number;
  effectName: string;
  effectType: string;
  target: string;
  request: JsonValue;
  idempotencyKey: string;
  status: EffectStatus;
  attemptCount: number;
  outcome: JsonValue | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionReceipt {
  tenantId: string;
  receiptId: string;
  requestId: string;
  principalId: string;
  purpose: string;
  operation: string;
  snapshotTime: string;
  evidenceManifest: JsonValue;
  resultHash: string;
  result: JsonValue;
  createdAt: string;
}

export interface ReserveInventoryInput {
  orderId: string;
  sku: string;
  location: string;
  quantity: number;
  holdSeconds: number;
  idempotencyKey: string;
}

export interface ReservationResult {
  machine: MachineRecord;
  inventory: InventoryRecord;
  timerId: string;
}

export interface PaymentRequestInput {
  instanceId: string;
  amount: string;
  currency: string;
  paymentTarget: string;
  paymentStatusUrl?: string;
  idempotencyKey: string;
}

export interface PaymentOutcomeInput {
  effectId: string;
  idempotencyKey: string;
  status: "succeeded" | "failed" | "unknown";
  outcome?: JsonValue;
}

export interface CatalogDescription {
  protocolVersion: "0.1";
  storage: string;
  operations: string[];
  epistemicKinds: EpistemicKind[];
  strengthTypes: Strength["type"][];
  machineStates: MachineState[];
  guarantees: string[];
  limitations: string[];
}
