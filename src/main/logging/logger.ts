import fs from "node:fs";
import path from "node:path";
import { getKanbanDir } from "../kanban/config";

export type BackendLogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "silent";

export interface BackendLogger {
  child(bindings: Record<string, unknown>): BackendLogger;
  trace(message: string, fields?: object): void;
  debug(message: string, fields?: object): void;
  info(message: string, fields?: object): void;
  warn(message: string, fields?: object): void;
  error(message: string, fields?: object): void;
}

export interface BackendLogEntry extends Record<string, unknown> {
  ts: string;
  level: Exclude<BackendLogLevelName, "silent">;
  msg: string;
  pid: number;
}

type ActiveLogLevelName = Exclude<BackendLogLevelName, "silent">;

interface LoggerConfig {
  level: BackendLogLevelName;
  consoleEnabled: boolean;
  fileEnabled: boolean;
  maxStringLength: number;
  maxArrayLength: number;
  maxObjectEntries: number;
  maxDepth: number;
  retentionDays: number;
  logDir: string;
}

type LogObserver = (entry: BackendLogEntry) => void;

const LOG_LEVELS: Record<BackendLogLevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

const LOG_FILE_PATTERN = /^backend-(\d{4}-\d{2}-\d{2})\.log$/;
const SENSITIVE_FIELD_PATTERN = /(?:pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|credential)/i;
const IS_TEST_RUNTIME =
  process.env.NODE_ENV === "test"
  || process.env.BUN_ENV === "test"
  || process.argv.some((value) => value.toLowerCase().includes("test"));
const DEFAULT_LEVEL = "info";

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  return fallback;
}

function parseIntegerEnv(value: string | undefined, fallback: number, minimum: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(minimum, parsed);
}

function parseLevel(value: string | undefined): BackendLogLevelName {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "trace"
    || normalized === "debug"
    || normalized === "info"
    || normalized === "warn"
    || normalized === "error"
    || normalized === "silent"
  ) {
    return normalized;
  }
  return DEFAULT_LEVEL;
}

function createLoggerConfig(): LoggerConfig {
  const defaultLogDir = path.join(getKanbanDir(), "logs");
  const configuredLogDir = process.env.NODEX_LOG_DIR?.trim();

  return {
    level: parseLevel(process.env.NODEX_LOG_LEVEL),
    consoleEnabled: parseBooleanEnv(process.env.NODEX_LOG_CONSOLE, !IS_TEST_RUNTIME),
    fileEnabled: parseBooleanEnv(process.env.NODEX_LOG_FILE, !IS_TEST_RUNTIME),
    maxStringLength: parseIntegerEnv(process.env.NODEX_LOG_MAX_STRING_LENGTH, 1_200, 80),
    maxArrayLength: parseIntegerEnv(process.env.NODEX_LOG_MAX_ARRAY_LENGTH, 20, 1),
    maxObjectEntries: parseIntegerEnv(process.env.NODEX_LOG_MAX_OBJECT_ENTRIES, 40, 1),
    maxDepth: parseIntegerEnv(process.env.NODEX_LOG_MAX_DEPTH, 6, 2),
    retentionDays: parseIntegerEnv(process.env.NODEX_LOG_RETENTION_DAYS, 14, 1),
    logDir: configuredLogDir
      ? (path.isAbsolute(configuredLogDir) ? configuredLogDir : path.resolve(process.cwd(), configuredLogDir))
      : defaultLogDir,
  };
}

function formatTimestamp(date = new Date()): string {
  return date.toISOString();
}

function resolveLogFileName(date = new Date()): string {
  return `backend-${formatTimestamp(date).slice(0, 10)}.log`;
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeError(error: Error, context: SerializationContext, depth: number): Record<string, unknown> {
  return {
    name: error.name,
    message: truncateString(error.message, context.config.maxStringLength),
    stack: error.stack ? truncateString(error.stack, context.config.maxStringLength * 2) : undefined,
    cause: serializeValue((error as Error & { cause?: unknown }).cause, context, depth + 1, "cause"),
  };
}

interface SerializationContext {
  config: LoggerConfig;
  seen: WeakSet<object>;
}

function serializeValue(
  value: unknown,
  context: SerializationContext,
  depth: number,
  keyHint?: string,
): unknown {
  if (keyHint && SENSITIVE_FIELD_PATTERN.test(keyHint)) {
    return "[REDACTED]";
  }

  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateString(value, context.config.maxStringLength);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value, context, depth);

  if (depth >= context.config.maxDepth) {
    if (Array.isArray(value)) {
      return `[Array(${value.length})]`;
    }
    return "[Object]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, context.config.maxArrayLength)
      .map((entry) => serializeValue(entry, context, depth + 1));
  }

  if (value instanceof Map) {
    return serializeValue(Object.fromEntries(value.entries()), context, depth + 1, keyHint);
  }

  if (value instanceof Set) {
    return serializeValue(Array.from(value.values()), context, depth + 1, keyHint);
  }

  if (typeof value === "object") {
    if (context.seen.has(value)) return "[Circular]";
    context.seen.add(value);

    if (!isPlainObject(value)) {
      const tag = value.constructor?.name ?? "Object";
      return `[${tag}]`;
    }

    const serialized: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, context.config.maxObjectEntries);
    for (const [entryKey, entryValue] of entries) {
      serialized[entryKey] = serializeValue(entryValue, context, depth + 1, entryKey);
    }
    return serialized;
  }

  return String(value);
}

class DailyLogFileWriter {
  private stream: fs.WriteStream | null = null;
  private activeFileName: string | null = null;
  private pruneAttempted = false;

  constructor(private readonly config: LoggerConfig) {}

  write(line: string): void {
    if (!this.config.fileEnabled) return;

    try {
      const stream = this.ensureStream();
      stream.write(`${line}\n`);
    } catch {
      // Logging must never throw back into application flows.
    }
  }

  async shutdown(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    this.activeFileName = null;

    if (!stream) return;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }

  private ensureStream(): fs.WriteStream {
    const fileName = resolveLogFileName();
    if (this.stream && this.activeFileName === fileName) {
      return this.stream;
    }

    this.stream?.end();
    fs.mkdirSync(this.config.logDir, { recursive: true });

    if (!this.pruneAttempted) {
      this.pruneAttempted = true;
      this.pruneOldFiles();
    }

    const nextPath = path.join(this.config.logDir, fileName);
    this.stream = fs.createWriteStream(nextPath, { flags: "a" });
    this.activeFileName = fileName;
    return this.stream;
  }

  private pruneOldFiles(): void {
    const cutoffMs = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    if (!fs.existsSync(this.config.logDir)) return;

    const entries = fs.readdirSync(this.config.logDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = LOG_FILE_PATTERN.exec(entry.name);
      if (!match) continue;
      const timestamp = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (!Number.isFinite(timestamp) || timestamp >= cutoffMs) continue;
      fs.rmSync(path.join(this.config.logDir, entry.name), { force: true });
    }
  }
}

class BackendLoggerImpl implements BackendLogger {
  constructor(
    private readonly config: LoggerConfig,
    private readonly fileWriter: DailyLogFileWriter,
    private readonly observers: Set<LogObserver>,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  child(bindings: Record<string, unknown>): BackendLogger {
    return new BackendLoggerImpl(this.config, this.fileWriter, this.observers, {
      ...this.bindings,
      ...bindings,
    });
  }

  trace(message: string, fields?: object): void {
    this.log("trace", message, fields);
  }

  debug(message: string, fields?: object): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields?: object): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields?: object): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields?: object): void {
    this.log("error", message, fields);
  }

  private log(level: ActiveLogLevelName, message: string, fields?: object): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.config.level]) return;

    const entry = this.buildEntry(level, message, fields);
    const line = JSON.stringify(entry);

    if (this.config.consoleEnabled) {
      const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
      try {
        stream.write(`${line}\n`);
      } catch {
        // Ignore console sink failures.
      }
    }

    this.fileWriter.write(line);

    for (const observer of this.observers) {
      observer(entry);
    }
  }

  private buildEntry(
    level: ActiveLogLevelName,
    message: string,
    fields?: object,
  ): BackendLogEntry {
    const context: SerializationContext = {
      config: this.config,
      seen: new WeakSet<object>(),
    };

    const serializedFields = fields
      ? (serializeValue(fields, context, 0) as Record<string, unknown>)
      : {};
    const serializedBindings = serializeValue(this.bindings, context, 0) as Record<string, unknown>;

    return {
      ts: formatTimestamp(),
      level,
      msg: truncateString(message, this.config.maxStringLength),
      pid: process.pid,
      ...serializedBindings,
      ...serializedFields,
    };
  }
}

let loggerConfig = createLoggerConfig();
let logObservers = new Set<LogObserver>();
let logFileWriter = new DailyLogFileWriter(loggerConfig);
let rootLogger: BackendLogger = new BackendLoggerImpl(loggerConfig, logFileWriter, logObservers, {
  app: "nodex",
  scope: "backend",
});

function resetLoggerInternals(): void {
  loggerConfig = createLoggerConfig();
  logObservers = new Set<LogObserver>();
  logFileWriter = new DailyLogFileWriter(loggerConfig);
  rootLogger = new BackendLoggerImpl(loggerConfig, logFileWriter, logObservers, {
    app: "nodex",
    scope: "backend",
  });
}

export function getLogger(bindings?: Record<string, unknown>): BackendLogger {
  if (!bindings) return rootLogger;
  return rootLogger.child(bindings);
}

export function subscribeToBackendLogs(observer: LogObserver): () => void {
  logObservers.add(observer);
  return () => {
    logObservers.delete(observer);
  };
}

export function getBackendLogDirectory(): string {
  return loggerConfig.logDir;
}

export async function shutdownBackendLogger(): Promise<void> {
  await logFileWriter.shutdown();
}

export async function resetBackendLoggerForTests(): Promise<void> {
  await logFileWriter.shutdown();
  resetLoggerInternals();
}
