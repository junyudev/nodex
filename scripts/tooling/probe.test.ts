import { expect, test } from "vite-plus/test";
import { runToolingProbe } from "./probe";

const nodeProbe = (source: string, timeoutMs = 10_000) => ({
  command: process.execPath,
  args: ["-e", source],
  timeoutMs,
});

test("closes stdin and drains both pipes while preserving expected nonzero fixture exits", async () => {
  const result = await runToolingProbe(
    "invalid fixture",
    nodeProbe(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write('x'.repeat(2 * 1024 * 1024) + 'stdout end');
      process.stderr.write('y'.repeat(2 * 1024 * 1024) + 'stderr end');
      process.exitCode = 7;
    });
  `),
  );
  expect(result.status).toBe(7);
  expect(result.stdout).toHaveLength(2 * 1024 * 1024 + "stdout end".length);
  expect(result.stderr).toHaveLength(2 * 1024 * 1024 + "stderr end".length);
  expect(result.stdout.endsWith("stdout end")).toBe(true);
  expect(result.stderr.endsWith("stderr end")).toBe(true);
});

test("bounds a sleeping child on every supported platform", async () => {
  await expect(
    runToolingProbe("sleep", nodeProbe("setInterval(() => {}, 1000)", 500)),
  ).rejects.toThrow("sleep: timed out after 500ms.");
});

test("preserves diagnostics for platform-specific forced termination", async () => {
  const result = runToolingProbe(
    "terminated lint",
    nodeProbe(`
      process.stderr.write('lint diagnostic', () => process.kill(process.pid, 'SIGKILL'));
    `),
  );
  if (process.platform === "win32") {
    // A self-kill uses TerminateProcess with exit code 1 on Windows.
    await expect(result).resolves.toEqual({ status: 1, stdout: "", stderr: "lint diagnostic" });
    return;
  }
  await expect(result).rejects.toThrow(
    /terminated lint: probe failed: Error: Terminated by SIGKILL[\s\S]*stderr \(tail\):\nlint diagnostic/u,
  );
});
