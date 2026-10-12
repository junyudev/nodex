import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";

const waitForOwnedSignalExit = (): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
}> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.resolve("tests/fixtures/effect-process-entry/owned-signal.ts")],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let signaled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Owned-signal fixture timed out: ${stderr}`));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (signaled || !stdout.includes("ready\n")) return;
      signaled = true;
      child.kill("SIGINT");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout });
    });
  });

describe("Effect process entry", () => {
  test("leaves termination signals to the scoped program and lets its cleanup finish", async () => {
    await expect(waitForOwnedSignalExit()).resolves.toEqual({
      code: 0,
      signal: null,
      stdout: "ready\nhandled\ncleaned\n",
    });
  });
});
