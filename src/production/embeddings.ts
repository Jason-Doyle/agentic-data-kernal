import * as z from "zod/v4";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_VERSION = "openai-compatible-v1";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
export const MAX_INDEXED_VECTOR_DIMENSIONS = 2000;

export interface EmbeddingSpace {
  model: string;
  version: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

const responseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number().finite()),
    }),
  ),
  model: z.string().optional(),
});

export class OpenAiCompatibleEmbeddingProvider
  implements EmbeddingProvider
{
  private readonly embeddingsUrl: string;

  public constructor(
    baseUrl: string,
    private readonly apiKey: string,
    public readonly model: string,
    public readonly dimensions: number,
    private readonly timeoutMs: number,
    public readonly version = DEFAULT_EMBEDDING_VERSION,
  ) {
    validateEmbeddingSpace(this);
    const normalizedBaseUrl = baseUrl.endsWith("/")
      ? baseUrl
      : `${baseUrl}/`;
    this.embeddingsUrl = new URL(
      "embeddings",
      normalizedBaseUrl,
    ).toString();
  }

  public async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    if (texts.length > 128) {
      throw new Error("Embedding batches are limited to 128 inputs");
    }
    for (const text of texts) {
      if (text.length === 0 || text.length > 100_000) {
        throw new Error("Embedding input must contain 1 to 100000 characters");
      }
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(this.embeddingsUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: this.model,
              input: texts,
              dimensions: this.dimensions,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 1_000);
          if (response.status === 429 || response.status >= 500) {
            lastError = new Error(
              `Embedding provider returned ${response.status}: ${detail}`,
            );
            await delay(250 * 2 ** attempt);
            continue;
          }
          throw new Error(
            `Embedding provider rejected the request with ${response.status}: ${detail}`,
          );
        }
        const parsed = responseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new Error(
            `Embedding provider returned an invalid response: ${z.prettifyError(parsed.error)}`,
          );
        }
        const ordered = [...parsed.data.data].sort(
          (left, right) => left.index - right.index,
        );
        if (ordered.length !== texts.length) {
          throw new Error("Embedding provider returned the wrong result count");
        }
        return ordered.map((item) =>
          validateEmbeddingVector(item.embedding, this.dimensions),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError")
        ) {
          lastError = new Error("Embedding provider timed out");
          await delay(250 * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new Error("Embedding provider failed");
  }
}

export function embeddingSpace(
  provider: Pick<EmbeddingProvider, "model" | "version" | "dimensions">,
): EmbeddingSpace {
  return validateEmbeddingSpace({
    model: provider.model,
    version: provider.version,
    dimensions: provider.dimensions,
  });
}

export function validateEmbeddingSpace(space: EmbeddingSpace): EmbeddingSpace {
  const model = space.model.trim();
  const version = space.version.trim();
  if (!model) {
    throw new Error("Embedding model must not be empty");
  }
  if (!version) {
    throw new Error("Embedding version must not be empty");
  }
  if (
    !Number.isInteger(space.dimensions) ||
    space.dimensions < 1 ||
    space.dimensions > MAX_INDEXED_VECTOR_DIMENSIONS
  ) {
    throw new Error(
      `Embedding dimensions must be an integer from 1 to ${MAX_INDEXED_VECTOR_DIMENSIONS}`,
    );
  }
  return { model, version, dimensions: space.dimensions };
}

export function validateEmbeddingVector(
  values: number[],
  dimensions: number,
): number[] {
  if (
    values.length !== dimensions ||
    !values.every(Number.isFinite)
  ) {
    throw new Error(
      `Embedding must contain ${dimensions} finite values`,
    );
  }
  if (!values.some((value) => value !== 0)) {
    throw new Error("Cosine embeddings must not be zero vectors");
  }
  return values;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
