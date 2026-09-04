export { AgenticKernel, KernelError } from "./kernel.js";
export {
  agentOperationSchema,
  executeIntent,
  intentEnvelopeSchema,
  parseIntentEnvelope,
} from "./ir.js";
export type {
  AgentOperation,
  IntentEnvelope,
  IntentExecutionResult,
} from "./ir.js";
export {
  AGENCY_OPERATION_NAMES,
  AgencyLayer,
  DEVELOPMENT_OPERATION_NAMES,
  KNOWLEDGE_OPERATION_NAMES,
  KnowledgeLayer,
  isAgencyOperation,
  isKnowledgeOperation,
  isRetailCompatibilityOperation,
  operationLayer,
  operationLayerCatalog,
  PRODUCTION_OPERATION_NAMES,
  RETAIL_COMPATIBILITY_OPERATION_NAMES,
  RetailCompatibilityAdapter,
} from "./layers.js";
export type {
  AgencyOperation,
  AgencyOperationName,
  AgentOperationName,
  KnowledgeOperation,
  KnowledgeOperationName,
  OperationLayer,
  RetailCompatibilityOperation,
  RetailCompatibilityOperationName,
} from "./layers.js";
export { SqliteStore } from "./store.js";
export {
  formatTraceExplanation,
  normalizeTraceDepth,
  parseTraceEndpoint,
  summarizeTraceJson,
  traceEndpointKey,
} from "./explain.js";
export type * from "./types.js";
export {
  AGENT_INTENT_VERSION,
  LEGACY_AGENT_INTENT_VERSION,
  PACKAGE_VERSION,
  SUPPORTED_AGENT_INTENT_VERSIONS,
} from "./version.js";
export type { AgentIntentVersion } from "./version.js";
