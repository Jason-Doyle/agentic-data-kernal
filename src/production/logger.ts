import pino, { type Logger } from "pino";
import type { ProductionConfig } from "./config.js";

export function createLogger(
  config: Pick<ProductionConfig, "logLevel">,
): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "authorization",
        "apiKey",
        "token",
        "embeddingApiKey",
        "authPepper",
        "artifactKeyring",
      ],
      censor: "[redacted]",
    },
    base: {
      service: "agentic-data-kernel",
      version: "0.2.0",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
