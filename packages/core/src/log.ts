import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    name,
    level,
    redact: {
      paths: ["*.apiKey", "*.api_key", "*.password", "*.token", "*.refreshToken", "*.authorization", "headers.authorization"],
      censor: "[redacted]",
    },
  });
}

export const silentLogger: Logger = pino({ level: "silent" });
