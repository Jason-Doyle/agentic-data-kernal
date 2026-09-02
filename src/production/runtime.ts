import { EncryptedArtifactStore } from "./artifacts.js";
import type { ProductionConfig } from "./config.js";
import { ProductionDatabase } from "./database.js";
import { OpenAiCompatibleEmbeddingProvider } from "./embeddings.js";
import { ProductionKernel } from "./kernel.js";
import { createLogger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";

export function createProductionRuntime(config: ProductionConfig): {
  database: ProductionDatabase;
  artifactStore: EncryptedArtifactStore;
  embeddings: OpenAiCompatibleEmbeddingProvider;
  metrics: MetricsRegistry;
  logger: ReturnType<typeof createLogger>;
  kernel: ProductionKernel;
} {
  const database = new ProductionDatabase(config);
  const artifactStore = new EncryptedArtifactStore(
    config.artifactDirectory,
    config.artifactKeyring,
  );
  const embeddings = new OpenAiCompatibleEmbeddingProvider(
    config.embeddingBaseUrl,
    config.embeddingApiKey,
    config.embeddingModel,
    config.embeddingDimensions,
    config.embeddingTimeoutMs,
  );
  const metrics = new MetricsRegistry();
  const logger = createLogger(config);
  const kernel = new ProductionKernel(
    database,
    artifactStore,
    embeddings,
    config,
    metrics,
    logger,
  );
  return {
    database,
    artifactStore,
    embeddings,
    metrics,
    logger,
    kernel,
  };
}
