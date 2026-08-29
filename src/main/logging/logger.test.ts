import { describe, expect, test, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_ENV = {
  NODEX_HOME: process.env.NODEX_HOME,
  NODEX_LOG_LEVEL: process.env.NODEX_LOG_LEVEL,
  NODEX_LOG_CONSOLE_LEVEL: process.env.NODEX_LOG_CONSOLE_LEVEL,
  NODEX_LOG_FILE_LEVEL: process.env.NODEX_LOG_FILE_LEVEL,
  NODEX_LOG_OBSERVER_LEVEL: process.env.NODEX_LOG_OBSERVER_LEVEL,
  NODEX_LOG_FILE: process.env.NODEX_LOG_FILE,
  NODEX_LOG_CONSOLE: process.env.NODEX_LOG_CONSOLE,
  NODEX_LOG_DIR: process.env.NODEX_LOG_DIR,
  NODEX_LOG_MAX_FILE_BYTES: process.env.NODEX_LOG_MAX_FILE_BYTES,
  NODEX_LOG_MAX_TOTAL_BYTES: process.env.NODEX_LOG_MAX_TOTAL_BYTES,
  NODEX_LOG_MAX_QUEUE_ENTRIES: process.env.NODEX_LOG_MAX_QUEUE_ENTRIES,
  NODEX_LOG_MAX_QUEUE_BYTES: process.env.NODEX_LOG_MAX_QUEUE_BYTES,
  NODEX_INTERNAL_APP_PACKAGED: process.env.NODEX_INTERNAL_APP_PACKAGED,
};

async function importLoggerModule() {
  vi.resetModules();
  const loggerModule = await import("./logger");
  loggerModule.configureBackendLogger({
    cwd: process.cwd(),
    environment: { ...process.env },
    nodexHome: process.env.NODEX_HOME?.trim() || path.join(process.cwd(), ".nodex-test"),
  });
  return loggerModule;
}

function restoreEnv(): void {
  if (ORIGINAL_ENV.NODEX_HOME === undefined) delete process.env.NODEX_HOME;
  else process.env.NODEX_HOME = ORIGINAL_ENV.NODEX_HOME;

  if (ORIGINAL_ENV.NODEX_LOG_LEVEL === undefined) delete process.env.NODEX_LOG_LEVEL;
  else process.env.NODEX_LOG_LEVEL = ORIGINAL_ENV.NODEX_LOG_LEVEL;

  if (ORIGINAL_ENV.NODEX_LOG_CONSOLE_LEVEL === undefined)
    delete process.env.NODEX_LOG_CONSOLE_LEVEL;
  else process.env.NODEX_LOG_CONSOLE_LEVEL = ORIGINAL_ENV.NODEX_LOG_CONSOLE_LEVEL;

  if (ORIGINAL_ENV.NODEX_LOG_FILE_LEVEL === undefined) delete process.env.NODEX_LOG_FILE_LEVEL;
  else process.env.NODEX_LOG_FILE_LEVEL = ORIGINAL_ENV.NODEX_LOG_FILE_LEVEL;

  if (ORIGINAL_ENV.NODEX_LOG_OBSERVER_LEVEL === undefined)
    delete process.env.NODEX_LOG_OBSERVER_LEVEL;
  else process.env.NODEX_LOG_OBSERVER_LEVEL = ORIGINAL_ENV.NODEX_LOG_OBSERVER_LEVEL;

  if (ORIGINAL_ENV.NODEX_LOG_FILE === undefined) delete process.env.NODEX_LOG_FILE;
  else process.env.NODEX_LOG_FILE = ORIGINAL_ENV.NODEX_LOG_FILE;

  if (ORIGINAL_ENV.NODEX_LOG_CONSOLE === undefined) delete process.env.NODEX_LOG_CONSOLE;
  else process.env.NODEX_LOG_CONSOLE = ORIGINAL_ENV.NODEX_LOG_CONSOLE;

  if (ORIGINAL_ENV.NODEX_LOG_DIR === undefined) delete process.env.NODEX_LOG_DIR;
  else process.env.NODEX_LOG_DIR = ORIGINAL_ENV.NODEX_LOG_DIR;

  if (ORIGINAL_ENV.NODEX_LOG_MAX_FILE_BYTES === undefined)
    delete process.env.NODEX_LOG_MAX_FILE_BYTES;
  else process.env.NODEX_LOG_MAX_FILE_BYTES = ORIGINAL_ENV.NODEX_LOG_MAX_FILE_BYTES;

  if (ORIGINAL_ENV.NODEX_LOG_MAX_TOTAL_BYTES === undefined)
    delete process.env.NODEX_LOG_MAX_TOTAL_BYTES;
  else process.env.NODEX_LOG_MAX_TOTAL_BYTES = ORIGINAL_ENV.NODEX_LOG_MAX_TOTAL_BYTES;

  if (ORIGINAL_ENV.NODEX_LOG_MAX_QUEUE_ENTRIES === undefined)
    delete process.env.NODEX_LOG_MAX_QUEUE_ENTRIES;
  else process.env.NODEX_LOG_MAX_QUEUE_ENTRIES = ORIGINAL_ENV.NODEX_LOG_MAX_QUEUE_ENTRIES;

  if (ORIGINAL_ENV.NODEX_LOG_MAX_QUEUE_BYTES === undefined)
    delete process.env.NODEX_LOG_MAX_QUEUE_BYTES;
  else process.env.NODEX_LOG_MAX_QUEUE_BYTES = ORIGINAL_ENV.NODEX_LOG_MAX_QUEUE_BYTES;

  if (ORIGINAL_ENV.NODEX_INTERNAL_APP_PACKAGED === undefined)
    delete process.env.NODEX_INTERNAL_APP_PACKAGED;
  else process.env.NODEX_INTERNAL_APP_PACKAGED = ORIGINAL_ENV.NODEX_INTERNAL_APP_PACKAGED;
}

async function withTempLoggerEnv(run: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-logger-test-"));
  process.env.NODEX_HOME = root;
  process.env.NODEX_LOG_LEVEL = "info";
  process.env.NODEX_LOG_FILE = "true";
  process.env.NODEX_LOG_CONSOLE = "false";
  delete process.env.NODEX_LOG_DIR;

  try {
    await run(root);
  } finally {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("backend logger", () => {
  test("keeps info logs durable while the terminal defaults to warn and above", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-logger-test-"));
    process.env.NODEX_HOME = root;
    process.env.NODEX_LOG_FILE = "true";
    process.env.NODEX_LOG_CONSOLE = "true";
    process.env.NODEX_LOG_FILE_LEVEL = "info";
    process.env.NODEX_LOG_CONSOLE_LEVEL = "warn";
    delete process.env.NODEX_LOG_LEVEL;

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const loggerModule = await importLoggerModule();
      const logger = loggerModule.getLogger({ component: "sink-level-test" });
      logger.info("durable info");
      logger.warn("visible warning");
      await loggerModule.shutdownBackendLogger();

      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalledTimes(1);
      expect(String(stderrWrite.mock.calls[0]?.[0])).toContain("visible warning");

      const logDir = loggerModule.getBackendLogDirectory();
      const records = fs.readdirSync(logDir).flatMap((fileName) =>
        fs
          .readFileSync(path.join(logDir, fileName), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { level: string; msg: string }),
      );
      expect(records.map((record) => [record.level, record.msg])).toEqual([
        ["info", "durable info"],
        ["warn", "visible warning"],
      ]);

      await loggerModule.resetBackendLoggerForTests();
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("redacts sensitive fields and writes to the backend log file", async () => {
    await withTempLoggerEnv(async () => {
      const loggerModule = await importLoggerModule();
      const captured: Array<Record<string, unknown>> = [];
      const unsubscribe = loggerModule.subscribeToBackendLogs((entry: Record<string, unknown>) => {
        captured.push(entry);
      });

      try {
        const logger = loggerModule.getLogger({ component: "logger-test" });
        logger.info("Testing structured logging", {
          authorization: "Bearer secret-value",
          nested: {
            apiKey: "abc123",
          },
          ok: true,
        });

        await loggerModule.shutdownBackendLogger();

        expect(captured.length).toBe(1);
        expect(captured[0].component).toBe("logger-test");
        expect(captured[0].authorization).toBe("[REDACTED]");

        const nested = captured[0].nested as Record<string, unknown>;
        expect(nested.apiKey).toBe("[REDACTED]");

        const logDir = loggerModule.getBackendLogDirectory();
        const entries = fs.readdirSync(logDir);
        expect(entries.length).toBe(1);

        const raw = fs.readFileSync(path.join(logDir, entries[0]), "utf8");
        expect(raw.includes('"authorization":"[REDACTED]"')).toBe(true);
        expect(raw.includes('"apiKey":"[REDACTED]"')).toBe(true);
      } finally {
        unsubscribe();
        await loggerModule.resetBackendLoggerForTests();
      }
    });
  });

  test("truncates oversized string payloads", async () => {
    await withTempLoggerEnv(async () => {
      const loggerModule = await importLoggerModule();
      const captured: Array<Record<string, unknown>> = [];
      const unsubscribe = loggerModule.subscribeToBackendLogs((entry: Record<string, unknown>) => {
        captured.push(entry);
      });

      try {
        const logger = loggerModule.getLogger({ component: "logger-test" });
        logger.info("Testing truncation", {
          longValue: "x".repeat(3_000),
        });

        expect(captured.length).toBe(1);
        const longValue = captured[0].longValue;
        expect(typeof longValue).toBe("string");
        expect((longValue as string).length < 3_000).toBe(true);
        expect((longValue as string).endsWith("…")).toBe(true);
      } finally {
        unsubscribe();
        await loggerModule.resetBackendLoggerForTests();
      }
    });
  });

  test("does not write production packaged logs unless a sink is explicitly enabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-logger-test-"));
    const logDir = path.join(root, "logs");
    process.env.NODEX_HOME = root;
    process.env.NODEX_INTERNAL_APP_PACKAGED = "true";
    process.env.NODEX_LOG_LEVEL = "info";
    process.env.NODEX_LOG_DIR = logDir;
    delete process.env.NODEX_LOG_FILE;
    delete process.env.NODEX_LOG_CONSOLE;

    try {
      const loggerModule = await importLoggerModule();
      const logger = loggerModule.getLogger({ component: "logger-test" });
      logger.info("Testing packaged default logging");
      await loggerModule.shutdownBackendLogger();

      expect(fs.existsSync(logDir)).toBe(false);
      await loggerModule.resetBackendLoggerForTests();
    } finally {
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows packaged file logging when explicitly enabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-logger-test-"));
    const logDir = path.join(root, "logs");
    process.env.NODEX_HOME = root;
    process.env.NODEX_INTERNAL_APP_PACKAGED = "true";
    process.env.NODEX_LOG_LEVEL = "info";
    process.env.NODEX_LOG_FILE = "true";
    process.env.NODEX_LOG_CONSOLE = "false";
    process.env.NODEX_LOG_DIR = logDir;

    try {
      const loggerModule = await importLoggerModule();
      const logger = loggerModule.getLogger({ component: "logger-test" });
      logger.info("Testing packaged opt-in logging");
      await loggerModule.shutdownBackendLogger();

      const entries = fs.readdirSync(logDir);
      expect(entries.length).toBe(1);
      await loggerModule.resetBackendLoggerForTests();
    } finally {
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rotates JSONL segments and enforces the global byte budget", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-logger-test-"));
    const logDir = path.join(root, "logs");
    process.env.NODEX_HOME = root;
    process.env.NODEX_LOG_FILE = "true";
    process.env.NODEX_LOG_CONSOLE = "false";
    process.env.NODEX_LOG_FILE_LEVEL = "info";
    process.env.NODEX_LOG_MAX_FILE_BYTES = "1024";
    process.env.NODEX_LOG_MAX_TOTAL_BYTES = "4096";
    process.env.NODEX_LOG_DIR = logDir;
    delete process.env.NODEX_LOG_LEVEL;

    try {
      const loggerModule = await importLoggerModule();
      const logger = loggerModule.getLogger({ component: "rotation-test" });
      for (let index = 0; index < 30; index += 1) {
        logger.info("segment record", { index, payload: "x".repeat(300) });
      }
      await loggerModule.shutdownBackendLogger();

      const files = fs.readdirSync(logDir).sort();
      expect(files.length).toBeGreaterThan(1);
      expect(
        files.every((fileName) => /^backend-\d{4}-\d{2}-\d{2}-\d{3}\.log$/.test(fileName)),
      ).toBe(true);

      const totalBytes = files.reduce(
        (total, fileName) => total + fs.statSync(path.join(logDir, fileName)).size,
        0,
      );
      expect(totalBytes).toBeLessThanOrEqual(4096);
      for (const fileName of files) {
        const lines = fs.readFileSync(path.join(logDir, fileName), "utf8").trim().split("\n");
        expect(
          lines.every((line) => {
            JSON.parse(line);
            return true;
          }),
        ).toBe(true);
      }

      await loggerModule.resetBackendLoggerForTests();
    } finally {
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds the pending file queue while preserving an error record", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-logger-test-"));
    const logDir = path.join(root, "logs");
    process.env.NODEX_HOME = root;
    process.env.NODEX_LOG_FILE = "true";
    process.env.NODEX_LOG_CONSOLE = "false";
    process.env.NODEX_LOG_FILE_LEVEL = "debug";
    process.env.NODEX_LOG_MAX_QUEUE_ENTRIES = "1";
    process.env.NODEX_LOG_MAX_QUEUE_BYTES = "2048";
    process.env.NODEX_LOG_DIR = logDir;
    delete process.env.NODEX_LOG_LEVEL;

    try {
      const loggerModule = await importLoggerModule();
      const logger = loggerModule.getLogger({ component: "queue-test" });
      for (let index = 0; index < 50; index += 1) {
        logger.debug("high-volume diagnostic", { index });
      }
      logger.error("must survive queue pressure");
      await loggerModule.shutdownBackendLogger();

      const records = fs.readdirSync(logDir).flatMap((fileName) =>
        fs
          .readFileSync(path.join(logDir, fileName), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { msg: string }),
      );
      expect(records.some((record) => record.msg.includes("records dropped"))).toBe(true);
      expect(records.some((record) => record.msg === "must survive queue pressure")).toBe(true);

      await loggerModule.resetBackendLoggerForTests();
    } finally {
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
