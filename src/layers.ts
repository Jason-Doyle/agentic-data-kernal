import type { AgentOperation } from "./ir.js";
import type { AgenticKernel } from "./kernel.js";
import type {
  AdvanceWorkflowInput,
  ArtifactInput,
  ArtifactRecord,
  AssertionInput,
  AssertionQuery,
  AssertionRecord,
  CreateWorkflowInput,
  EffectOutcomeInput,
  EffectListQuery,
  EffectRecord,
  EntityInput,
  EntityRecord,
  GenericEffectRequestInput,
  InventoryRecord,
  LineageEdgeRecord,
  LineageEndpoint,
  LineageInput,
  MachineRecord,
  OperationLayerCatalog,
  PaymentOutcomeInput,
  PaymentRequestInput,
  PrincipalContext,
  ReservationResult,
  ReserveInventoryInput,
  ResolutionPolicy,
  ResolutionResult,
  SearchHit,
  SearchQuery,
  TraceExplanation,
  WorkflowRecord,
} from "./types.js";

export const KNOWLEDGE_OPERATION_NAMES = [
  "put_entity",
  "put_artifact",
  "assert",
  "resolve",
  "search",
  "add_lineage",
  "explain",
] as const;

export const AGENCY_OPERATION_NAMES = [
  "create_workflow",
  "advance_workflow",
  "request_effect",
  "record_effect_outcome",
  "get_machine",
  "list_effects",
] as const;

export const RETAIL_COMPATIBILITY_OPERATION_NAMES = [
  "seed_inventory",
  "reserve_inventory",
  "request_payment",
  "record_payment_outcome",
  "process_timers",
] as const;

export type KnowledgeOperationName =
  (typeof KNOWLEDGE_OPERATION_NAMES)[number];
export type AgencyOperationName =
  (typeof AGENCY_OPERATION_NAMES)[number];
export type RetailCompatibilityOperationName =
  (typeof RETAIL_COMPATIBILITY_OPERATION_NAMES)[number];
export type AgentOperationName =
  | KnowledgeOperationName
  | AgencyOperationName
  | RetailCompatibilityOperationName;
export type OperationLayer =
  | "knowledge"
  | "agency"
  | "retail_compatibility";

export type KnowledgeOperation = Extract<
  AgentOperation,
  { op: KnowledgeOperationName }
>;
export type AgencyOperation = Extract<
  AgentOperation,
  { op: AgencyOperationName }
>;
export type RetailCompatibilityOperation = Extract<
  AgentOperation,
  { op: RetailCompatibilityOperationName }
>;

type MissingOperationNames = Exclude<
  AgentOperation["op"],
  AgentOperationName
>;
type UnknownOperationNames = Exclude<
  AgentOperationName,
  AgentOperation["op"]
>;
const operationNamesMatchSchema: [
  MissingOperationNames,
  UnknownOperationNames,
] extends [never, never]
  ? true
  : never = true;
void operationNamesMatchSchema;

const knowledgeOperationSet = new Set<string>(
  KNOWLEDGE_OPERATION_NAMES,
);
const agencyOperationSet = new Set<string>(AGENCY_OPERATION_NAMES);
const retailCompatibilityOperationSet = new Set<string>(
  RETAIL_COMPATIBILITY_OPERATION_NAMES,
);

export const DEVELOPMENT_OPERATION_NAMES: readonly AgentOperationName[] = [
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
];

export const PRODUCTION_OPERATION_NAMES: readonly AgentOperationName[] =
  DEVELOPMENT_OPERATION_NAMES.filter(
    (name) =>
      name !== "record_effect_outcome" &&
      name !== "record_payment_outcome",
  );

export function operationLayer(
  operationName: AgentOperationName,
): OperationLayer {
  if (knowledgeOperationSet.has(operationName)) {
    return "knowledge";
  }
  if (agencyOperationSet.has(operationName)) {
    return "agency";
  }
  if (retailCompatibilityOperationSet.has(operationName)) {
    return "retail_compatibility";
  }
  throw new Error(`Unknown Agent Intent operation ${operationName}`);
}

export function isKnowledgeOperation(
  operation: AgentOperation,
): operation is KnowledgeOperation {
  return knowledgeOperationSet.has(operation.op);
}

export function isAgencyOperation(
  operation: AgentOperation,
): operation is AgencyOperation {
  return agencyOperationSet.has(operation.op);
}

export function isRetailCompatibilityOperation(
  operation: AgentOperation,
): operation is RetailCompatibilityOperation {
  return retailCompatibilityOperationSet.has(operation.op);
}

export function operationLayerCatalog(
  availableOperations: readonly AgentOperationName[],
): OperationLayerCatalog {
  const available = new Set<string>(availableOperations);
  return {
    knowledge: KNOWLEDGE_OPERATION_NAMES.filter((name) =>
      available.has(name),
    ),
    agency: AGENCY_OPERATION_NAMES.filter((name) =>
      available.has(name),
    ),
    retailCompatibility: RETAIL_COMPATIBILITY_OPERATION_NAMES.filter(
      (name) => available.has(name),
    ),
  };
}

export class KnowledgeLayer {
  public constructor(private readonly kernel: AgenticKernel) {}

  public putEntity(
    principal: PrincipalContext,
    input: EntityInput,
  ): EntityRecord {
    return this.kernel.putEntity(principal, input);
  }

  public putArtifact(
    principal: PrincipalContext,
    input: ArtifactInput,
  ): ArtifactRecord {
    return this.kernel.putArtifact(principal, input);
  }

  public getArtifact(
    tenantId: string,
    artifactId: string,
  ): ArtifactRecord {
    return this.kernel.getArtifact(tenantId, artifactId);
  }

  public assert(
    principal: PrincipalContext,
    input: AssertionInput,
  ): AssertionRecord {
    return this.kernel.assert(principal, input);
  }

  public getEntity(tenantId: string, entityId: string): EntityRecord {
    return this.kernel.getEntity(tenantId, entityId);
  }

  public getAssertion(
    tenantId: string,
    assertionId: string,
  ): AssertionRecord {
    return this.kernel.getAssertion(tenantId, assertionId);
  }

  public queryAssertions(
    tenantId: string,
    query: AssertionQuery = {},
  ): AssertionRecord[] {
    return this.kernel.queryAssertions(tenantId, query);
  }

  public resolve(
    tenantId: string,
    subjectEntityId: string,
    predicate: string,
    policy: ResolutionPolicy = "none",
    options: Pick<
      AssertionQuery,
      "perspective" | "validAt" | "systemAt"
    > = {},
  ): ResolutionResult {
    return this.kernel.resolve(
      tenantId,
      subjectEntityId,
      predicate,
      policy,
      options,
    );
  }

  public search(tenantId: string, query: SearchQuery): SearchHit[] {
    return this.kernel.search(tenantId, query);
  }

  public addLineage(
    principal: PrincipalContext,
    input: LineageInput,
  ): LineageEdgeRecord {
    return this.kernel.addLineage(principal, input);
  }

  public explain(
    tenantId: string,
    root: LineageEndpoint,
    maxDepth = 4,
  ): TraceExplanation {
    return this.kernel.explain(tenantId, root, maxDepth);
  }
}

export class AgencyLayer {
  public constructor(private readonly kernel: AgenticKernel) {}

  public createWorkflow(
    principal: PrincipalContext,
    input: CreateWorkflowInput,
  ): WorkflowRecord {
    return this.kernel.createWorkflow(principal, input);
  }

  public advanceWorkflow(
    principal: PrincipalContext,
    input: AdvanceWorkflowInput,
  ): WorkflowRecord {
    return this.kernel.advanceWorkflow(principal, input);
  }

  public requestEffect(
    principal: PrincipalContext,
    input: GenericEffectRequestInput,
  ): EffectRecord {
    return this.kernel.requestEffect(principal, input);
  }

  public recordEffectOutcome(
    principal: PrincipalContext,
    input: EffectOutcomeInput,
  ): EffectRecord {
    return this.kernel.recordEffectOutcome(principal, input);
  }

  public getMachine(
    tenantId: string,
    instanceId: string,
  ): MachineRecord | WorkflowRecord {
    return this.kernel.getMachineRecord(tenantId, instanceId);
  }

  public getWorkflow(
    tenantId: string,
    instanceId: string,
  ): WorkflowRecord {
    return this.kernel.getWorkflow(tenantId, instanceId);
  }

  public listEffects(
    tenantId: string,
    instanceId?: string,
    query: EffectListQuery = {},
  ): EffectRecord[] {
    return this.kernel.listEffects(tenantId, instanceId, query);
  }
}

export class RetailCompatibilityAdapter {
  public constructor(private readonly kernel: AgenticKernel) {}

  public seedInventory(
    principal: PrincipalContext,
    sku: string,
    location: string,
    quantityOnHand: number,
  ): InventoryRecord {
    return this.kernel.seedInventory(
      principal,
      sku,
      location,
      quantityOnHand,
    );
  }

  public getInventory(
    tenantId: string,
    sku: string,
    location: string,
  ): InventoryRecord {
    return this.kernel.getInventory(tenantId, sku, location);
  }

  public reserveInventory(
    principal: PrincipalContext,
    input: ReserveInventoryInput,
  ): ReservationResult {
    return this.kernel.reserveInventory(principal, input);
  }

  public requestPayment(
    principal: PrincipalContext,
    input: PaymentRequestInput,
  ): EffectRecord {
    return this.kernel.requestPayment(principal, input);
  }

  public recordPaymentOutcome(
    principal: PrincipalContext,
    input: PaymentOutcomeInput,
  ): MachineRecord {
    return this.kernel.recordPaymentOutcome(principal, input);
  }

  public processTimers(
    principal: PrincipalContext,
    asOf?: string,
  ): MachineRecord[] {
    return this.kernel.processDueTimers(principal, asOf);
  }

  public getOrder(tenantId: string, instanceId: string): MachineRecord {
    return this.kernel.getMachine(tenantId, instanceId);
  }
}
