import { errorMonitor, type EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { configureBackendLogger, getLogger, shutdownBackendLogger } from "../logger";

export interface StdioFailureResult {
  readonly kind: "result";
  readonly stderrErrors: number;
  readonly stderrErrorCodes: string[];
  readonly uncaughtExceptions: number;
  readonly pendingStderrBytes: number;
  readonly stderrHighWaterMark: number;
}

const home = process.argv[2];
if (!home) throw new Error("Logging fixture requires a temporary home");

configureBackendLogger({
  cwd: process.cwd(),
  nodexHome: home,
  environment: {
    NODEX_LOG_CONSOLE: "true",
    NODEX_LOG_CONSOLE_LEVEL: "info",
    NODEX_LOG_FILE: "true",
    NODEX_LOG_FILE_LEVEL: "warn",
    NODEX_LOG_MAX_FILE_BYTES: "4096",
    NODEX_LOG_MAX_TOTAL_BYTES: "16384",
    NODEX_LOG_MAX_QUEUE_BYTES: "8192",
    NODEX_LOG_STREAM_BUFFER_BYTES: "4096",
  },
});

const logger = getLogger({ component: "stdio-failure-test" });
const stderr = process.stderr;
const stderrEvents: EventEmitter = stderr;
let stderrErrors = 0;
let uncaughtExceptions = 0;
const stderrErrorCodes = new Set<string>();

// Observes the real OS failure without handling it, unlike an "error" listener.
stderrEvents.on(errorMonitor, (error: NodeJS.ErrnoException) => {
  stderrErrors += 1;
  stderrErrorCodes.add(error.code ?? "unknown");
});
process.on("uncaughtException", (error: Error) => {
  uncaughtExceptions += 1;
  // Model the incident's reporting loop, but cap it so a regression stays safe.
  if (uncaughtExceptions > 3) return;
  logger.error("uncaught exception reporting attempted", { error });
});

process.once("message", () => {
  void run();
});
process.send?.({ kind: "ready" });

async function run(): Promise<void> {
  logger.warn("terminal probe");
  await setImmediate();
  for (let index = 0; index < 2_000; index += 1) {
    logger.warn("continued diagnostics", { index, payload: "x".repeat(1_200) });
  }
  await setImmediate();
  logger.info("stdout remains available");
  logger.error("durable after terminal failure");
  await shutdownBackendLogger();
  await setImmediate();

  const result: StdioFailureResult = {
    kind: "result",
    stderrErrors,
    stderrErrorCodes: [...stderrErrorCodes],
    uncaughtExceptions,
    pendingStderrBytes: stderr.writableLength,
    stderrHighWaterMark: stderr.writableHighWaterMark,
  };
  process.send?.(result, () => process.disconnect());
}
