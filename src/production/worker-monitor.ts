import { createServer, type Server } from "node:http";
import type { ProductionConfig } from "./config.js";
import type { ProductionDatabase } from "./database.js";
import type { MetricsRegistry } from "./metrics.js";

export async function startWorkerMonitor(
  config: Pick<
    ProductionConfig,
    "workerMonitorHost" | "workerMonitorPort"
  >,
  database: ProductionDatabase,
  metrics: MetricsRegistry,
): Promise<Server> {
  const server = createServer(
    {
      requestTimeout: 5_000,
      headersTimeout: 5_000,
      keepAliveTimeout: 2_000,
      maxHeaderSize: 8_192,
    },
    async (request, response) => {
      try {
        const path = new URL(
          request.url ?? "/",
          `http://${config.workerMonitorHost}:${config.workerMonitorPort}`,
        ).pathname;
        if (request.method === "GET" && path === "/health/live") {
          send(response, 200, '{"status":"ok"}', "application/json");
          return;
        }
        if (request.method === "GET" && path === "/health/ready") {
          const healthy = await database.health();
          send(
            response,
            healthy ? 200 : 503,
            JSON.stringify({
              status: healthy ? "ready" : "not_ready",
            }),
            "application/json",
          );
          return;
        }
        if (request.method === "GET" && path === "/metrics") {
          send(
            response,
            200,
            metrics.render(),
            "text/plain; version=0.0.4",
          );
          return;
        }
        send(
          response,
          404,
          '{"error":"not_found"}',
          "application/json",
        );
      } catch {
        send(
          response,
          503,
          '{"status":"not_ready"}',
          "application/json",
        );
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      config.workerMonitorPort,
      config.workerMonitorHost,
      () => {
        server.off("error", reject);
        resolve();
      },
    );
  });
  return server;
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}
