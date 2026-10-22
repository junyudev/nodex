import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, vi } from "vite-plus/test";
import { runCommand } from "./process";

const detachedDescendant = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"
  ], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.once('data', () => process.stdout.write(JSON.stringify([process.pid, child.pid])));
  setInterval(() => {}, 1000);
`;

function stopFixtureGroups(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Normally the cancellation under test has already stopped the fixture.
    }
  }
}

function expectFixtureStopped(pids: readonly number[]): void {
  expect(pids).toHaveLength(2);
  const result = spawnSync("ps", ["-p", pids.join(","), "-o", "pid=,stat="], {
    encoding: "utf8",
    timeout: 1_000,
    killSignal: "SIGKILL",
  });
  expect([0, 1]).toContain(result.status);
  for (const row of result.stdout.trim().split("\n").filter(Boolean)) {
    expect(row.trim().split(/\s+/u)[1]).toMatch(/^Z/u);
  }
}

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
  "waits for detached descendants that outlive their command parent",
  async () => {
    const controller = new AbortController();
    let pids: number[] = [];
    try {
      const result = await runCommand({
        command: process.execPath,
        args: ["-e", detachedDescendant],
        signal: controller.signal,
        onStdout: (chunk) => {
          pids = JSON.parse(chunk);
          controller.abort();
        },
      });
      expect(result.exitCode).toBe(130);
      expectFixtureStopped(pids);
    } finally {
      stopFixtureGroups(pids);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "rejects a denied descendant cleanup instead of throwing from a timer",
  async () => {
    const controller = new AbortController();
    const signalProcess = process.kill.bind(process);
    let pids: number[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -pids[1]) throw Object.assign(new Error("root-owned group"), { code: "EPERM" });
      return signalProcess(pid, signal);
    });
    try {
      await expect(
        runCommand({
          command: process.execPath,
          args: ["-e", detachedDescendant],
          signal: controller.signal,
          onStdout: (chunk) => {
            pids = JSON.parse(chunk);
            controller.abort();
          },
        }),
      ).rejects.toThrow("root-owned group");
      expect(signalProcess(pids[1], 0)).toBe(true);
    } finally {
      kill.mockRestore();
      stopFixtureGroups(pids);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "refuses successful cancellation when the descendant snapshot fails",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex failed process snapshot "));
    const controller = new AbortController();
    let pids: number[] = [];
    try {
      await writeFile(
        path.join(root, "ps"),
        '#!/bin/sh\nif [ "$2" = "pid=,ppid=,pgid=,rss=" ]; then exit 1; fi\nexec /bin/ps "$@"\n',
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", root + path.delimiter + process.env.PATH);
      await expect(
        runCommand({
          command: process.execPath,
          args: ["-e", detachedDescendant],
          signal: controller.signal,
          onStdout: (chunk) => {
            pids = JSON.parse(chunk);
            controller.abort();
          },
        }),
      ).rejects.toThrow("Could not stop command process groups");
      expect(process.kill(pids[1], 0)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      stopFixtureGroups(pids);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || process.env.CI !== "true")(
  "stops root-owned detached installer descendants on the Linux CI runner",
  async () => {
    const controller = new AbortController();
    let pids: number[] = [];
    try {
      const result = await runCommand({
        command: "sudo",
        args: ["-n", process.execPath, "-e", detachedDescendant],
        privilegedCancellation: true,
        signal: controller.signal,
        onStdout: (chunk) => {
          pids = JSON.parse(chunk);
          controller.abort();
        },
      });
      expect(result.exitCode).toBe(130);
      expectFixtureStopped(pids);
      expect(result.durationMs).toBeLessThan(10_000);
    } finally {
      for (const pid of pids) {
        try {
          execFileSync("sudo", ["-n", "/bin/kill", "-s", "SIGKILL", "--", String(-pid)], {
            stdio: "ignore",
            timeout: 1_000,
            killSignal: "SIGKILL",
          });
        } catch {
          // Normally the cancellation under test has already stopped the fixture.
        }
      }
    }
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
