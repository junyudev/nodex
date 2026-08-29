import fs from "node:fs";
import path from "node:path";
import {
  isLogLevelEnabled,
  resolveLogSinkLevels,
  type ActiveLogLevelName,
  type LogLevelName,
} from "./log-level";

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
  level: ActiveLogLevelName;
  msg: string;
  pid: number;
}

interface LoggerConfig {
  consoleLevel: LogLevelName;
  fileLevel: LogLevelName;
  observerLevel: LogLevelName;
  consoleEnabled: boolean;
  fileEnabled: boolean;
  maxStringLength: number;
  maxArrayLength: number;
  maxObjectEntries: number;
  maxDepth: number;
  retentionDays: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxQueueEntries: number;
  maxQueueBytes: number;
  streamHighWaterMarkBytes: number;
  flushTimeoutMs: number;
  logDir: string;
}

type LogObserver = (entry: BackendLogEntry) => void;

interface LogObserverSubscription {
  observer: LogObserver;
  level: LogLevelName;
}

interface QueuedLogLine {
  line: string;
  bytes: number;
  level: ActiveLogLevelName;
}

interface BackendLogFile {
  name: string;
  filePath: string;
  date: string;
  segment: number | null;
  size: number;
  mtimeMs: number;
}

const LOG_FILE_PATTERN = /^backend-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.log$/;
const SENSITIVE_FIELD_PATTERN =
  /(?:pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|credential)/i;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_STREAM_HIGH_WATER_MARK_BYTES = 1024 * 1024;

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off")
    return false;
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on")
    return true;
  return fallback;
}

function parseIntegerEnv(value: string | undefined, fallback: number, minimum: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(minimum, parsed);
}

function createLoggerConfig(input: {
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly nodexHome: string;
}): LoggerConfig {
  const environment = input.environment;
  const defaultLogDir = path.join(input.nodexHome, "logs");
  const configuredLogDir = environment.NODEX_LOG_DIR?.trim();
  const isTestRuntime = environment.NODE_ENV === "test" || environment.BUN_ENV === "test";
  const isPackagedRuntime = parseBooleanEnv(environment.NODEX_INTERNAL_APP_PACKAGED, false);
  const defaultSinkEnabled = !isTestRuntime && !isPackagedRuntime;
  const sinkLevels = resolveLogSinkLevels(environment);
  const maxFileBytes = parseIntegerEnv(
    environment.NODEX_LOG_MAX_FILE_BYTES,
    DEFAULT_MAX_FILE_BYTES,
    1_024,
  );
  const configuredMaxTotalBytes = parseIntegerEnv(
    environment.NODEX_LOG_MAX_TOTAL_BYTES,
    DEFAULT_MAX_TOTAL_BYTES,
    1_024,
  );

  return {
    consoleLevel: sinkLevels.console,
    fileLevel: sinkLevels.file,
    observerLevel: sinkLevels.observer,
    consoleEnabled: parseBooleanEnv(environment.NODEX_LOG_CONSOLE, defaultSinkEnabled),
    fileEnabled: parseBooleanEnv(environment.NODEX_LOG_FILE, defaultSinkEnabled),
    maxStringLength: parseIntegerEnv(environment.NODEX_LOG_MAX_STRING_LENGTH, 1_200, 80),
    maxArrayLength: parseIntegerEnv(environment.NODEX_LOG_MAX_ARRAY_LENGTH, 20, 1),
    maxObjectEntries: parseIntegerEnv(environment.NODEX_LOG_MAX_OBJECT_ENTRIES, 40, 1),
    maxDepth: parseIntegerEnv(environment.NODEX_LOG_MAX_DEPTH, 6, 2),
    retentionDays: parseIntegerEnv(environment.NODEX_LOG_RETENTION_DAYS, 14, 1),
    maxFileBytes,
    maxTotalBytes: Math.max(maxFileBytes, configuredMaxTotalBytes),
    maxQueueEntries: parseIntegerEnv(environment.NODEX_LOG_MAX_QUEUE_ENTRIES, 10_000, 1),
    maxQueueBytes: parseIntegerEnv(
      environment.NODEX_LOG_MAX_QUEUE_BYTES,
      DEFAULT_MAX_QUEUE_BYTES,
      1_024,
    ),
    streamHighWaterMarkBytes: parseIntegerEnv(
      environment.NODEX_LOG_STREAM_BUFFER_BYTES,
      DEFAULT_STREAM_HIGH_WATER_MARK_BYTES,
      1_024,
    ),
    flushTimeoutMs: parseIntegerEnv(environment.NODEX_LOG_FLUSH_TIMEOUT_MS, 2_000, 100),
    logDir: configuredLogDir
      ? path.isAbsolute(configuredLogDir)
        ? configuredLogDir
        : path.resolve(input.cwd, configuredLogDir)
      : defaultLogDir,
  };
}

function formatTimestamp(date = new Date()): string {
  return date.toISOString();
}

function resolveLogDate(date = new Date()): string {
  return formatTimestamp(date).slice(0, 10);
}

function resolveLogFileName(date: string, segment: number): string {
  return `backend-${date}-${String(segment).padStart(3, "0")}.log`;
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

function serializeError(
  error: Error,
  context: SerializationContext,
  depth: number,
): Record<string, unknown> {
  return {
    name: error.name,
    message: truncateString(error.message, context.config.maxStringLength),
    stack: error.stack
      ? truncateString(error.stack, context.config.maxStringLength * 2)
      : undefined,
    cause: serializeValue(
      (error as Error & { cause?: unknown }).cause,
      context,
      depth + 1,
      "cause",
    ),
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

function readBackendLogFiles(logDir: string): BackendLogFile[] {
  if (!fs.existsSync(logDir)) return [];

  const files: BackendLogFile[] = [];
  for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = LOG_FILE_PATTERN.exec(entry.name);
    if (!match) continue;

    const filePath = path.join(logDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      files.push({
        name: entry.name,
        filePath,
        date: match[1],
        segment: match[2] === undefined ? null : Number.parseInt(match[2], 10),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // A file may disappear while retention is inspecting it.
    }
  }
  return files;
}

function logPriority(level: ActiveLogLevelName): number {
  if (level === "trace") return 10;
  if (level === "debug") return 20;
  if (level === "info") return 30;
  if (level === "warn") return 40;
  return 50;
}

class RotatingJsonlLogWriter {
  private stream: fs.WriteStream | null = null;
  private activeDate: string | null = null;
  private activeSegment = 0;
  private activeFileBytes = 0;
  private queue: QueuedLogLine[] = [];
  private queuedBytes = 0;
  private pumpPromise: Promise<void> | null = null;
  private accepting = true;
  private failed = false;
  private failureReported = false;
  private readonly droppedByLevel: Record<ActiveLogLevelName, number> = {
    trace: 0,
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
  };

  constructor(private readonly config: LoggerConfig) {}

  write(level: ActiveLogLevelName, line: string): void {
    if (!this.config.fileEnabled || !this.accepting || this.failed) return;

    const bytes = Buffer.byteLength(line, "utf8") + 1;
    const item = { line, bytes, level } satisfies QueuedLogLine;
    if (!this.makeQueueRoom(item)) {
      this.recordDrop(level);
      this.startPump();
      return;
    }

    this.queue.push(item);
    this.queuedBytes += bytes;
    this.startPump();
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    this.startPump();

    while (this.pumpPromise) {
      await this.pumpPromise;
    }

    await this.closeActiveStream();
  }

  private makeQueueRoom(incoming: QueuedLogLine): boolean {
    const fits = () =>
      this.queue.length < this.config.maxQueueEntries &&
      this.queuedBytes + incoming.bytes <= this.config.maxQueueBytes;
    if (fits()) return true;
    if (incoming.level !== "warn" && incoming.level !== "error") return false;

    while (!fits()) {
      const evictIndex = this.queue.findIndex(
        (item) => logPriority(item.level) < logPriority(incoming.level),
      );
      if (evictIndex < 0) return false;
      const [evicted] = this.queue.splice(evictIndex, 1);
      this.queuedBytes -= evicted.bytes;
      this.recordDrop(evicted.level);
    }
    return true;
  }

  private recordDrop(level: ActiveLogLevelName): void {
    this.droppedByLevel[level] += 1;
  }

  private startPump(): void {
    if (this.pumpPromise || this.failed || !this.config.fileEnabled) return;
    if (this.queue.length === 0 && !this.hasDroppedLines()) return;

    this.pumpPromise = this.drainQueue()
      .catch((error: unknown) => {
        this.disableFileSink(error);
      })
      .finally(() => {
        this.pumpPromise = null;
        if (this.queue.length > 0 || this.hasDroppedLines()) {
          this.startPump();
        }
      });
  }

  private async drainQueue(): Promise<void> {
    while (!this.failed) {
      const droppedSummary = this.takeDroppedSummary();
      if (droppedSummary) {
        await this.writeRecord(droppedSummary);
        continue;
      }

      const item = this.queue.shift();
      if (!item) return;
      this.queuedBytes -= item.bytes;
      await this.writeRecord(item);
    }
  }

  private hasDroppedLines(): boolean {
    return Object.values(this.droppedByLevel).some((count) => count > 0);
  }

  private takeDroppedSummary(): QueuedLogLine | null {
    if (!this.hasDroppedLines()) return null;

    const dropped = { ...this.droppedByLevel };
    for (const level of Object.keys(this.droppedByLevel) as ActiveLogLevelName[]) {
      this.droppedByLevel[level] = 0;
    }

    const line = JSON.stringify({
      ts: formatTimestamp(),
      level: "warn",
      msg: "Backend log records dropped because the file sink queue was full",
      pid: process.pid,
      app: "nodex",
      scope: "backend",
      subsystem: "logging",
      component: "file-sink",
      dropped,
    });
    return {
      line,
      bytes: Buffer.byteLength(line, "utf8") + 1,
      level: "warn",
    };
  }

  private async writeRecord(item: QueuedLogLine): Promise<void> {
    await this.ensureStream(item.bytes);
    const stream = this.stream;
    if (!stream || this.failed) {
      throw new Error("Backend log stream is unavailable");
    }

    const canContinue = stream.write(`${item.line}\n`);
    this.activeFileBytes += item.bytes;
    if (canContinue) return;
    await this.waitForDrain(stream);
  }

  private async ensureStream(incomingBytes: number): Promise<void> {
    const date = resolveLogDate();
    const dateChanged = this.activeDate !== null && this.activeDate !== date;
    const segmentFull =
      this.stream !== null &&
      this.activeFileBytes > 0 &&
      this.activeFileBytes + incomingBytes > this.config.maxFileBytes;

    if (dateChanged) {
      await this.closeActiveStream();
      this.activeDate = null;
      this.activeSegment = 0;
      this.activeFileBytes = 0;
    } else if (segmentFull) {
      await this.closeActiveStream();
      this.activeSegment += 1;
      this.activeFileBytes = 0;
    }

    if (this.stream) return;
    this.openStream(date);
  }

  private openStream(date: string): void {
    fs.mkdirSync(this.config.logDir, { recursive: true, mode: 0o700 });
    this.pruneFiles();

    const latest = readBackendLogFiles(this.config.logDir)
      .filter((file) => file.date === date && file.segment !== null)
      .sort((left, right) => (right.segment ?? 0) - (left.segment ?? 0))[0];

    if (this.activeDate !== date) {
      this.activeDate = date;
      this.activeSegment = latest?.segment ?? 0;
      this.activeFileBytes = latest?.size ?? 0;
      if (this.activeFileBytes >= this.config.maxFileBytes) {
        this.activeSegment += 1;
        this.activeFileBytes = 0;
      }
    }

    const filePath = path.join(
      this.config.logDir,
      resolveLogFileName(this.activeDate, this.activeSegment),
    );
    const stream = fs.createWriteStream(filePath, {
      flags: "a",
      mode: 0o600,
      highWaterMark: this.config.streamHighWaterMarkBytes,
    });
    stream.on("error", this.handleStreamError);
    this.stream = stream;
  }

  private pruneFiles(): void {
    try {
      const cutoffMs = Date.now() - this.config.retentionDays * DAY_MS;
      let files = readBackendLogFiles(this.config.logDir);

      for (const file of files) {
        const timestamp = Date.parse(`${file.date}T00:00:00.000Z`);
        if (!Number.isFinite(timestamp) || timestamp >= cutoffMs) continue;
        try {
          fs.rmSync(file.filePath, { force: true });
        } catch {
          // Retention is best effort; logging should continue on the remaining files.
        }
      }

      files = readBackendLogFiles(this.config.logDir).sort(
        (left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
      );
      let totalBytes = files.reduce((total, file) => total + file.size, 0);
      const targetBytes = Math.max(0, this.config.maxTotalBytes - this.config.maxFileBytes);

      for (const file of files) {
        if (totalBytes <= targetBytes) break;
        try {
          fs.rmSync(file.filePath, { force: true });
          totalBytes -= file.size;
        } catch {
          // Global size pruning is also best effort.
        }
      }
    } catch {
      // Directory inspection failures must not disable a writable log sink.
    }
  }

  private waitForDrain(stream: fs.WriteStream): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        stream.off("drain", onDrain);
        stream.off("error", onError);
        stream.off("close", onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Backend log stream closed before draining"));
      };

      stream.once("drain", onDrain);
      stream.once("error", onError);
      stream.once("close", onClose);
    });
  }

  private async closeActiveStream(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        stream.off("finish", finish);
        stream.off("close", finish);
        stream.off("error", finish);
        stream.off("error", this.handleStreamError);
        resolve();
      };
      const timeout = setTimeout(() => {
        stream.destroy();
        finish();
      }, this.config.flushTimeoutMs);

      stream.once("finish", finish);
      stream.once("close", finish);
      stream.once("error", finish);
      stream.end();
    });
  }

  private readonly handleStreamError = (error: Error): void => {
    this.disableFileSink(error);
  };

  private disableFileSink(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.queue = [];
    this.queuedBytes = 0;
    const stream = this.stream;
    this.stream = null;
    if (stream && !stream.destroyed) {
      stream.destroy();
    }

    if (this.failureReported) return;
    this.failureReported = true;
    const detail = error instanceof Error ? error.message : String(error);
    try {
      process.stderr.write(`[nodex] ERROR backend file logging disabled: ${detail}\n`);
    } catch {
      // There is no remaining safe sink during a file and stderr failure.
    }
  }
}

class BackendLoggerImpl implements BackendLogger {
  constructor(
    private readonly config: LoggerConfig,
    private readonly fileWriter: RotatingJsonlLogWriter,
    private readonly observers: Set<LogObserverSubscription>,
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
    const writeConsole =
      this.config.consoleEnabled && isLogLevelEnabled(level, this.config.consoleLevel);
    const writeFile = this.config.fileEnabled && isLogLevelEnabled(level, this.config.fileLevel);
    const notifyObservers = Array.from(this.observers).some((subscription) =>
      isLogLevelEnabled(level, subscription.level),
    );
    if (!writeConsole && !writeFile && !notifyObservers) return;

    let entry: BackendLogEntry;
    let line: string;
    try {
      entry = this.buildEntry(level, message, fields);
      line = JSON.stringify(entry);
    } catch {
      // Serialization failures must not affect application control flow.
      return;
    }

    if (writeConsole) {
      const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
      try {
        stream.write(`${line}\n`);
      } catch {
        // Ignore console sink failures.
      }
    }

    if (writeFile) {
      this.fileWriter.write(level, line);
    }

    if (!notifyObservers) return;
    for (const subscription of this.observers) {
      if (!isLogLevelEnabled(level, subscription.level)) continue;
      try {
        subscription.observer(entry);
      } catch {
        // One diagnostics observer must not break logging or other observers.
      }
    }
  }

  private buildEntry(level: ActiveLogLevelName, message: string, fields?: object): BackendLogEntry {
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

const initialLoggerSource = {
  cwd: process.cwd(),
  environment: { NODEX_LOG_CONSOLE: "false", NODEX_LOG_FILE: "false" },
  nodexHome: path.join(process.cwd(), ".nodex-unconfigured"),
};
let loggerConfig = createLoggerConfig(initialLoggerSource);
let logObservers = new Set<LogObserverSubscription>();
let logFileWriter = new RotatingJsonlLogWriter(loggerConfig);
let rootLogger: BackendLogger = new BackendLoggerImpl(loggerConfig, logFileWriter, logObservers, {
  app: "nodex",
  scope: "backend",
});

function resetLoggerInternals(): void {
  loggerConfig = createLoggerConfig({
    cwd: process.cwd(),
    environment: process.env,
    nodexHome: process.env.NODEX_HOME?.trim() || path.join(process.cwd(), ".nodex-test"),
  });
  logObservers = new Set<LogObserverSubscription>();
  logFileWriter = new RotatingJsonlLogWriter(loggerConfig);
  rootLogger = new BackendLoggerImpl(loggerConfig, logFileWriter, logObservers, {
    app: "nodex",
    scope: "backend",
  });
}

/** Binds all pre-created logger children to the immutable Profile authority. */
export function configureBackendLogger(input: {
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly nodexHome: string;
}): void {
  Object.assign(loggerConfig, createLoggerConfig(input));
}

export function getLogger(bindings?: Record<string, unknown>): BackendLogger {
  if (!bindings) return rootLogger;
  return rootLogger.child(bindings);
}

export function subscribeToBackendLogs(
  observer: LogObserver,
  options: { level?: LogLevelName } = {},
): () => void {
  const subscription: LogObserverSubscription = {
    observer,
    level: options.level ?? loggerConfig.observerLevel,
  };
  logObservers.add(subscription);
  return () => {
    logObservers.delete(subscription);
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
