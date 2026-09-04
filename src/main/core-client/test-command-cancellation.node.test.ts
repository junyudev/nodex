import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
import { runCommand } from "../../../scripts/tooling/process";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};

test.skipIf(process.platform === "win32")(
  "cancelling a test command reaps its detached Core authority",
  async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nodex-cancelled-test-"));
    const controller = new AbortController();
    let corePid: number | undefined;
    try {
      const result = await runCommand({
        command: process.execPath,
        args: [
          "-e",
          `
        const { spawn } = require('node:child_process');
        const { existsSync } = require('node:fs');
        const child = spawn(process.argv[1], ['--home', process.argv[2]], {
          detached: true, stdio: 'ignore',
        });
        const poll = setInterval(() => {
          if (!existsSync(process.argv[2] + '/run/core/core.sock')) return;
          clearInterval(poll);
          process.stdout.write(String(child.pid));
        }, 20);
        setInterval(() => {}, 1000);
      `,
          requiredNativeExecutable("core-server"),
          home,
        ],
        signal: controller.signal,
        onStdout: (chunk) => {
          corePid = Number(chunk);
          controller.abort();
        },
      });
      expect(result.exitCode).toBe(130);
      expect(corePid).toBeGreaterThan(0);
      await expect
        .poll(() => corePid !== undefined && isAlive(corePid), { timeout: 3_000 })
        .toBe(false);
    } finally {
      controller.abort();
      if (corePid !== undefined && isAlive(corePid)) process.kill(corePid, "SIGKILL");
      await rm(home, { recursive: true, force: true });
    }
  },
);
