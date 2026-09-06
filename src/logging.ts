import pino from "pino";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(tmpdir(), "wanderlog-mcp");

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function configuredLevel(): LogLevel {
  const raw = process.env.WANDERLOG_LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function logFilePath(now: Date): string {
  return join(LOG_DIR, `wanderlog-mcp-${now.toISOString().slice(0, 10)}.log`);
}

// One pino instance per process, writing synchronously so nothing is lost
// when the server calls process.exit() during shutdown/startup failure.
let fileSink: pino.Logger | undefined;
function getFileSink(): pino.Logger {
  fileSink ??= pino(
    // level filtering is done by our own gate in log() below, so this
    // stays at the lowest level and always writes what it's told to.
    { level: "debug", base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
    pino.destination({
      dest: logFilePath(new Date()),
      mkdir: true,
      append: true,
      sync: true,
    }),
  );
  return fileSink;
}

/**
 * stderr only — stdout is the MCP protocol channel on the stdio transport
 * and must never carry anything but JSON-RPC frames.
 */
function writeStderr(scope: string, message: string): void {
  process.stderr.write(`[${scope}] ${message}\n`);
}

function log(
  level: LogLevel,
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;

  writeStderr(scope, message);

  try {
    getFileSink()[level]({ scope, ...meta }, message);
  } catch {
    // Logging must never take down the server.
  }
}

export type Logger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

/**
 * Creates a scoped logger that writes to stderr (never stdout — see the
 * stdio transport invariant) and appends structured JSON to a dated file
 * under `<tmpdir>/wanderlog-mcp/`. Never pass cookie/session values as
 * message or meta — nothing here redacts them.
 */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => log("debug", scope, message, meta),
    info: (message, meta) => log("info", scope, message, meta),
    warn: (message, meta) => log("warn", scope, message, meta),
    error: (message, meta) => log("error", scope, message, meta),
  };
}
