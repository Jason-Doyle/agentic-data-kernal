import { OpenAiCompatibleEmbeddingProvider } from "agentic-data-kernel/production";

const provider = new OpenAiCompatibleEmbeddingProvider(
  required("EMBEDDING_BASE_URL"),
  required("EMBEDDING_API_KEY"),
  process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
  Number(process.env.EMBEDDING_DIMENSIONS ?? "1536"),
  Number(process.env.EMBEDDING_TIMEOUT_MS ?? "30000"),
  process.env.EMBEDDING_VERSION ?? "openai-compatible-v1",
);

const [embedding] = await provider.embed([
  "A customer reported intermittent checkout failures after a pricing update.",
]);
if (!embedding) {
  throw new Error("Embedding provider returned no vector");
}

console.log(
  JSON.stringify(
    {
      model: provider.model,
      version: provider.version,
      dimensions: embedding.length,
      finite: embedding.every(Number.isFinite),
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
