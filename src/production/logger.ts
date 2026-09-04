import pino, { type Logger } from "pino";
import type { ProductionConfig } from "./config.js";
import { PACKAGE_VERSION } from "../version.js";

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
      version: PACKAGE_VERSION,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
