import { createProductionHttpAgentMiddleware } from "agentic-data-kernel/production";

const workflowInstanceId = process.env.AGENTIC_DATA_INSTANCE_ID;
const session = createProductionHttpAgentMiddleware({
  baseUrl: required("AGENTIC_DATA_BASE_URL"),
  apiKey: required("AGENTIC_DATA_API_KEY"),
  principal: {
    tenantId: required("AGENTIC_DATA_TENANT_ID"),
    principalId: required("AGENTIC_DATA_PRINCIPAL_ID"),
    purpose: required("AGENTIC_DATA_PURPOSE"),
  },
}).beginRun({
  runId: process.env.AGENTIC_DATA_RUN_ID ?? `run:${Date.now()}`,
  taskId: process.env.AGENTIC_DATA_TASK_ID,
  conversationId: process.env.AGENTIC_DATA_CONVERSATION_ID,
});

const modelInput = await session.prepareModelInput({
  query: process.env.AGENTIC_DATA_QUERY ?? "current operational context",
  ...(workflowInstanceId
    ? {
        workflow: { instanceId: workflowInstanceId },
        effects: { instanceId: workflowInstanceId, limit: 10 },
      }
    : {}),
});

console.log(
  JSON.stringify(
    {
      tools: modelInput.tools,
      context: JSON.parse(modelInput.context.modelContext),
      includedReceiptIds: modelInput.context.includedReceiptIds,
      partialReceiptIds: modelInput.context.partialReceiptIds,
      omittedReceiptIds: modelInput.context.omittedReceiptIds,
    },
    null,
    2,
  ),
);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
