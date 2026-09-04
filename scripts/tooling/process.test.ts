import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect } from "vite-plus/test";
import { runCommand } from "./process";

test("preserves arguments, output, and nonzero exits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nodex command "));
  try {
    const output: string[] = [];
    const result = await runCommand({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exit(7)",
        "a b",
        "--flag",
        "$literal",
      ],
      cwd: root,
      logFile: path.join(root, "output.log"),
      onStdout: (chunk) => output.push(chunk),
    });
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(output.join(""))).toEqual(["a b", "--flag", "$literal"]);
    expect(await readFile(path.join(root, "output.log"), "utf8")).toBe(output.join(""));
    expect(result.durationMs).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancels a running command without waiting for its normal completion", async () => {
  const controller = new AbortController();
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
    signal: controller.signal,
    onStdout: () => controller.abort(),
  });
  expect(result.exitCode).toBe(130);
  expect(result.signal).not.toBeNull();
});

test("does not launch an already cancelled command", async () => {
  const result = await runCommand({
    command: "this-command-must-never-start",
    args: [],
    signal: AbortSignal.abort(),
  });
  expect(result).toEqual({ exitCode: 130, signal: "SIGINT", durationMs: 0 });
});
