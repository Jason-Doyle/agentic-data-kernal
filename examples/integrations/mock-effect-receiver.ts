import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

const certificatePath = process.env.TLS_CERT_PATH;
const privateKeyPath = process.env.TLS_KEY_PATH;
if ((certificatePath && !privateKeyPath) || (!certificatePath && privateKeyPath)) {
  throw new Error("Set both TLS_CERT_PATH and TLS_KEY_PATH, or neither");
}
const tlsEnabled = Boolean(certificatePath && privateKeyPath);
const port = Number(process.env.PORT ?? (tlsEnabled ? "8444" : "8092"));
const host = tlsEnabled ? process.env.HOST ?? "0.0.0.0" : "127.0.0.1";
const effects = new Map<string, { status: "succeeded"; providerReference: string }>();

const handler = async (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> => {
  try {
    const idempotencyKey = request.headers["idempotency-key"]?.toString();
    if (!idempotencyKey) {
      response.writeHead(400).end();
      return;
    }
    if (request.method === "POST" && request.url === "/capture") {
      await readBody(request);
      const existing =
        effects.get(idempotencyKey) ?? {
          status: "succeeded" as const,
          providerReference: `sample_${createHash("sha256")
            .update(idempotencyKey)
            .digest("hex")
            .slice(0, 20)}`,
        };
      effects.set(idempotencyKey, existing);
      sendJson(response, 200, existing);
      return;
    }
    if (
      request.method === "GET" &&
      request.url === `/status/${encodeURIComponent(idempotencyKey)}`
    ) {
      const effect = effects.get(idempotencyKey);
      sendJson(
        response,
        effect ? 200 : 404,
        effect ?? { status: "pending" },
      );
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response
      .writeHead(error instanceof RequestBodyTooLargeError ? 413 : 500)
      .end();
  }
};

const server =
  tlsEnabled && certificatePath && privateKeyPath
    ? createHttpsServer(
        {
          cert: readFileSync(certificatePath),
          key: readFileSync(privateKeyPath),
        },
        handler,
      )
    : createHttpServer(handler);

server.listen(port, host, () => {
  console.log(
    `Effect receiver example listening on ${
      tlsEnabled ? "https" : "http"
    }://${host}:${port}`,
  );
});

async function readBody(
  request: import("node:http").IncomingMessage,
): Promise<void> {
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 1_000_000) {
      throw new RequestBodyTooLargeError();
    }
  }
}

class RequestBodyTooLargeError extends Error {
  public constructor() {
    super("Request body is too large");
    this.name = "RequestBodyTooLargeError";
  }
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
