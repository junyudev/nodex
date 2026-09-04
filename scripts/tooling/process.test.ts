import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, vi } from "vite-plus/test";
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

test.skipIf(process.platform === "win32")(
  "escalates cancellation when a child ignores graceful termination",
  async () => {
    const controller = new AbortController();
    const result = await runCommand({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
      ],
      signal: controller.signal,
      onStdout: () => controller.abort(),
    });
    expect(result.exitCode).toBe(130);
    expect(result.signal).toBe("SIGKILL");
  },
);

test.skipIf(process.platform === "win32")(
  "finishes the command and stops a hung resource sampler",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex sampler "));
    const pidFile = path.join(root, "sampler.pid");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const sampler =
      "require('node:fs').writeFileSync(" +
      JSON.stringify(pidFile) +
      ", String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    let samplerPid: number | undefined;
    try {
      await writeFile(
        path.join(root, "ps"),
        "#!/bin/sh\nexec " + quote(process.execPath) + " -e " + quote(sampler) + "\n",
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", root + path.delimiter + process.env.PATH);
      const result = await runCommand({
        command: process.execPath,
        args: [
          "-e",
          "setInterval(() => { if (require('node:fs').existsSync(" +
            JSON.stringify(pidFile) +
            ")) process.exit(0) }, 20); setTimeout(() => process.exit(2), 10000)",
        ],
        measureResources: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.resources).toBeUndefined();
      samplerPid = Number(await readFile(pidFile, "utf8"));
      await vi.waitFor(() => {
        expect(() => process.kill(samplerPid!, 0)).toThrow();
      });
    } finally {
      vi.unstubAllEnvs();
      if (samplerPid) {
        try {
          process.kill(samplerPid, "SIGKILL");
        } catch {
          // The sampler is normally already gone when the command finishes.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
