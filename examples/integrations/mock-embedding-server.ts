import { createHash } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? "8091");
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? "1536");

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.url !== "/embeddings") {
      response.writeHead(404).end();
      return;
    }
    const body = await readJson(request);
    if (
      body === null ||
      typeof body !== "object" ||
      !("input" in body) ||
      !Array.isArray(body.input)
    ) {
      response.writeHead(400).end();
      return;
    }
    const data = body.input.map((value, index) => ({
      index,
      embedding: featureVector(String(value), dimensions),
    }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: "local-protocol-example", data }));
  } catch (error) {
    response
      .writeHead(error instanceof RequestBodyTooLargeError ? 413 : 400)
      .end();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Embedding protocol example listening on http://127.0.0.1:${port}`);
});

async function readJson(
  request: import("node:http").IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

class RequestBodyTooLargeError extends Error {
  public constructor() {
    super("Request body is too large");
    this.name = "RequestBodyTooLargeError";
  }
}

function featureVector(text: string, size: number): number[] {
  const vector = Array.from({ length: size }, () => 0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % size;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  return magnitude === 0
    ? vector
    : vector.map((value) => value / magnitude);
}
