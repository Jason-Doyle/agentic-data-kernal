import * as z from "zod/v4";

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
  public readonly version = "openai-compatible-v1";

  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    public readonly model: string,
    public readonly dimensions: number,
    private readonly timeoutMs: number,
  ) {}

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
        const response = await fetch(
          `${this.baseUrl.replace(/\/+$/, "")}/embeddings`,
          {
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
            signal: AbortSignal.timeout(this.timeoutMs),
          },
        );
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
        return ordered.map((item) => {
          if (item.embedding.length !== this.dimensions) {
            throw new Error(
              `Embedding dimension ${item.embedding.length} did not match ${this.dimensions}`,
            );
          }
          return item.embedding;
        });
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
