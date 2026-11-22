import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { ciBound, runToolingProbe } from "./probe";

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

test.skipIf(process.platform === "win32")(
  "attributes a sleeping probe timeout and kills its detached, SIGTERM-resistant descendant",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nodex-probe-"));
    const pidsFile = path.join(directory, "pids.json");
    let pids: number[] = [];
    try {
      const started = performance.now();
      await expect(
        runToolingProbe(
          "sleeping compiler",
          nodeProbe(
            `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e',
          "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"
        ], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
        child.stdout.once('data', () => {
          require('node:fs').writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([process.pid, child.pid]));
          process.stdout.write('a'.repeat(20_000) + 'last compiler output');
          process.stderr.write('last compiler error');
        });
        setInterval(() => {}, 1000);
      `,
            2_000,
          ),
        ),
      ).rejects.toThrow(
        /sleeping compiler: timed out after 2000ms[\s\S]*stdout \(tail\):[\s\S]*last compiler output[\s\S]*stderr \(tail\):\nlast compiler error/u,
      );
      // oxlint-disable-next-line nodex/no-wall-clock-in-tests -- The contract under test is a bounded real process-tree timeout, including kill escalation.
      expect(performance.now() - started).toBeLessThan(8_000);
      pids = JSON.parse(await readFile(pidsFile, "utf8"));
      expect(pids).toHaveLength(2);
      const rows = execFileSync("ps", ["-axo", "pid=,stat="], {
        encoding: "utf8",
        timeout: 1_000,
        killSignal: "SIGKILL",
      });
      for (const row of rows.trim().split("\n")) {
        const [pid, state] = row.trim().split(/\s+/u);
        if (pids.includes(Number(pid))) expect(state).toMatch(/^Z/u);
      }
    } finally {
      // A failed assertion must not leave the intentionally stubborn fixture behind.
      if (pids.length === 0) {
        try {
          pids = JSON.parse(await readFile(pidsFile, "utf8"));
        } catch {
          /* Child never started. */
        }
      }
      for (const pid of pids) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("attributes a signal exit with its diagnostic tail", async () => {
  await expect(
    runToolingProbe(
      "terminated lint",
      nodeProbe(`
    process.stderr.write('lint diagnostic', () => process.kill(process.pid, 'SIGKILL'));
  `),
    ),
  ).rejects.toThrow(/terminated lint: probe failed:[\s\S]*SIGKILL[\s\S]*lint diagnostic/u);
});

test("bounds probes on CI runners and leaves shared local computers unbounded", () => {
  expect(ciBound(120_000, { CI: "true" })).toBe(120_000);
  expect(ciBound(120_000, { CI: "1" })).toBe(120_000);
  expect(ciBound(120_000, {})).toBeNull();
  expect(ciBound(120_000, { CI: "false" })).toBeNull();
});
