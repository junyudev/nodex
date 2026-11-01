/* @effect-diagnostics asyncFunction:off -- Verifies an owned native process tree, including Windows taskkill. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { runCodexGitCommand } from "./codex/codex-git-command";
import { killChildProcessTree } from "./process-tree";

test.runIf(process.platform === "win32")(
  "terminates descendants of an owned Windows console process",
  async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../tests/fixtures/scoped-process-tree.mjs", import.meta.url))],
      { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
    );
    try {
      const [output] = await once(child.stdout!, "data");
      const [leader, descendant] = String(output).trim().split(" ").map(Number);
      expect(leader).toBe(child.pid);
      expect(descendant).toBeGreaterThan(0);
      const exited = once(child, "exit");
      killChildProcessTree(child, "SIGTERM", "win32");
      await exited;
      await expect
        .poll(() => {
          try {
            process.kill(descendant!, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    } finally {
      killChildProcessTree(child, "SIGKILL", "win32");
    }
  },
);

test.runIf(process.platform === "win32")(
  "cancelling Git terminates its shell command and descendants",
  async () => {
    const controller = new AbortController();
    const pids: number[] = [];
    let output = "";
    const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
    const fixture = fileURLToPath(
      new URL("../../tests/fixtures/scoped-process-tree.mjs", import.meta.url),
    );
    try {
      const command = runCodexGitCommand(
        ["-c", `alias.nodex-tree=!${quote(process.execPath)} ${quote(fixture)}`, "nodex-tree"],
        tmpdir(),
        {
          signal: controller.signal,
          timeoutMs: 10_000,
          onOutput: ({ stream, data }) => {
            if (stream !== "stdout") return;
            output += data;
            const ready = /^(\d+) (\d+)\r?\n/.exec(output);
            if (!ready || pids.length > 0) return;
            pids.push(Number(ready[1]), Number(ready[2]));
            controller.abort();
          },
        },
      );
      await expect(command).rejects.toThrow("Request canceled");
      expect(pids).toHaveLength(2);
      for (const pid of pids) {
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })
          .toBe(false);
      }
    } finally {
      controller.abort();
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The tree should already have exited; retain cleanup for a failed assertion.
        }
      }
    }
  },
);
