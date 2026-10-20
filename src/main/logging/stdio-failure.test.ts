import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { StdioFailureResult } from "./testing/stdio-failure-process";

const MAX_LOG_BYTES = 16 * 1024;

async function runStdioFixture(mode: "closed" | "blocked") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-stdio-failure-"));
  const child = fork(
    path.resolve(import.meta.dirname, "testing/stdio-failure-process.ts"),
    [home],
    {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-16_384);
  });
  const exited = once(child, "close");
  const received = new Promise<StdioFailureResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("message", (message: { kind?: string }) => {
      if (message.kind === "ready") {
        if (mode === "closed") child.stderr?.destroy();
        child.send("write");
        return;
      }
      if (message.kind !== "result") return;
      // The blocked-pipe case deliberately leaves stderr unread until this result.
      child.stderr?.resume();
      resolve(message as StdioFailureResult);
    });
    child.once("exit", (code, signal) => {
      reject(new Error(`Logging fixture exited before its result (${code}, ${signal}): ${stdout}`));
    });
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);

  try {
    const result = await received;
    const [code, signal] = await exited;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    const logDir = path.join(home, "logs");
    const files = fs.readdirSync(logDir);
    const bytes = files.reduce(
      (total, file) => total + fs.statSync(path.join(logDir, file)).size,
      0,
    );
    const records = files.flatMap((file) =>
      fs
        .readFileSync(path.join(logDir, file), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { msg: string }),
    );
    return { result, stdout, bytes, records };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdout?.destroy();
    child.stderr?.destroy();
    await exited.catch(() => undefined);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("terminal logging process boundary", () => {
  test("contains a real broken stderr pipe without recursive exceptions or losing durable logs", async () => {
    const { result, stdout, bytes, records } = await runStdioFixture("closed");

    expect(result.stderrErrorCodes).toEqual(["EPIPE"]);
    expect(result.uncaughtExceptions).toBe(0);
    expect(result.stderrErrors).toBe(1);
    expect(result.pendingStderrBytes).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({ msg: "stdout remains available" });
    expect(bytes).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(records.some((record) => record.msg === "durable after terminal failure")).toBe(true);
  });

  test("bounds real stderr buffering when its reader stops consuming output", async () => {
    const { result, bytes, records } = await runStdioFixture("blocked");

    expect(result.uncaughtExceptions).toBe(0);
    expect(result.stderrErrors).toBe(0);
    expect(result.pendingStderrBytes).toBeGreaterThan(0);
    expect(result.pendingStderrBytes).toBeLessThanOrEqual(result.stderrHighWaterMark + 2_048);
    expect(bytes).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(records.some((record) => record.msg === "durable after terminal failure")).toBe(true);
  });
});
