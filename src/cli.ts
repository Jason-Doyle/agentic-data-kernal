#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runExample } from "./example.js";
import { startHttpServer } from "./http.js";
import { AgenticKernel } from "./kernel.js";
import { executeIntent } from "./ir.js";
import { startMcpServer } from "./mcp.js";
import { SqliteStore } from "./store.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(helpText);
    return;
  }

  const dbPath = option(args, "--db") ?? ".data/agentic.db";
  const store = new SqliteStore(dbPath);
  const kernel = new AgenticKernel(store);

  if (command === "mcp") {
    await startMcpServer(kernel);
    return;
  }

  try {
    switch (command) {
      case "init":
        print({ database: resolve(dbPath), catalog: kernel.catalog() });
        break;
      case "catalog":
        print(kernel.catalog());
        break;
      case "example":
        print(runExample(kernel));
        break;
      case "execute": {
        const file = requiredOption(args, "--file");
        const input = JSON.parse(readFileSync(file, "utf8")) as unknown;
        print(executeIntent(kernel, input));
        break;
      }
      case "sql": {
        const query = option(args, "--query") ?? positional(args, 0);
        if (!query) {
          throw new Error("sql requires --query <read-only SQL>");
        }
        print({ rows: kernel.readSql(query) });
        break;
      }
      case "serve": {
        const port = Number(option(args, "--port") ?? "4318");
        const host = option(args, "--host") ?? "127.0.0.1";
        const server = await startHttpServer(kernel, { host, port });
        console.log(`Agentic Data Kernel listening on http://${host}:${port}`);
        await waitForShutdown(server, store);
        return;
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    store.close();
  }
}

async function waitForShutdown(
  server: import("node:http").Server,
  store: SqliteStore,
): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    const shutdown = (): void => {
      server.close(() => {
        store.close();
        resolveShutdown();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positional(args: string[], index: number): string | undefined {
  const values: string[] = [];
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    if (args[cursor]?.startsWith("--")) {
      cursor += 1;
      continue;
    }
    const value = args[cursor];
    if (value) {
      values.push(value);
    }
  }
  return values[index];
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const helpText = `Agentic Data Kernel

Usage:
  agentic-data init [--db path]
  agentic-data example [--db path]
  agentic-data catalog [--db path]
  agentic-data execute --file intent.json [--db path]
  agentic-data sql --query "SELECT ..." [--db path]
  agentic-data serve [--db path] [--host 127.0.0.1] [--port 4318]
  agentic-data mcp [--db path]
`;

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
