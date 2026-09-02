import { createServer, type IncomingMessage, type Server } from "node:http";
import { AgenticKernel, KernelError } from "./kernel.js";
import { executeIntent } from "./ir.js";

export interface HttpServerOptions {
  host?: string;
  port?: number;
}

export async function startHttpServer(
  kernel: AgenticKernel,
  options: HttpServerOptions = {},
): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4318;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${host}:${port}`);
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/catalog") {
        sendJson(response, 200, kernel.catalog());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/execute") {
        const body = await readJsonBody(request);
        sendJson(response, 200, executeIntent(kernel, body));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sql") {
        const body = await readJsonBody(request);
        if (
          body === null ||
          typeof body !== "object" ||
          !("query" in body) ||
          typeof body.query !== "string"
        ) {
          throw new KernelError(
            "invalid_input",
            "Body must contain a string query",
          );
        }
        sendJson(response, 200, { rows: kernel.readSql(body.query) });
        return;
      }
      sendJson(response, 404, {
        error: { code: "not_found", message: "Route not found" },
      });
    } catch (error) {
      const status = errorStatus(error);
      sendJson(response, status, {
        error: {
          code: error instanceof KernelError ? error.code : "internal_error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new KernelError("invalid_input", "Request body exceeds 1 MB");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new KernelError("invalid_input", "A JSON request body is required");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new KernelError("invalid_input", "Request body is not valid JSON");
  }
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function errorStatus(error: unknown): number {
  if (!(error instanceof KernelError)) {
    return 500;
  }
  switch (error.code) {
    case "invalid_input":
    case "unsafe_query":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "unauthorized":
      return 403;
  }
}
