/* @effect-diagnostics asyncFunction:off -- Verifies an owned native process tree, including Windows taskkill. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { runCodexGitCommand } from "./codex/codex-git-command";
import { killChildProcessTree, terminateWindowsProcessTree } from "./process-tree";

test.runIf(process.platform === "win32").each([
  ["synchronous", "SIGTERM"],
  ["synchronous", "SIGKILL"],
  ["asynchronous", "SIGTERM"],
  ["asynchronous", "SIGKILL"],
] as const)("terminates only the owned Windows console tree (%s, %s)", async (mode, signal) => {
  const fixture = fileURLToPath(
    new URL("../../tests/fixtures/scoped-process-tree.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [fixture], {
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  const unrelated = spawn(process.execPath, [fixture, "descendant"], {
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  const ownedPids = new Set<number>();
  for (const member of [child, unrelated]) {
    if (member.pid !== undefined) ownedPids.add(member.pid);
  }
  const failures: unknown[] = [];
  try {
    const [[output], [unrelatedOutput]] = await Promise.all([
      once(child.stdout!, "data"),
      once(unrelated.stdout!, "data"),
    ]);
    const [leader, descendant] = String(output).trim().split(" ").map(Number);
    expect(leader).toBe(child.pid);
    expect(Number(String(unrelatedOutput).trim())).toBe(unrelated.pid);
    if (descendant === undefined || !Number.isSafeInteger(descendant) || descendant <= 0) {
      throw new Error("The fixture did not report an owned descendant");
    }
    ownedPids.add(descendant);
    const exited = once(child, "exit");
    if (mode === "synchronous") killChildProcessTree(child, signal, "win32");
    else await terminateWindowsProcessTree(child.pid!, signal);
    await exited;
    expect(() => process.kill(descendant, 0)).toThrow(/ESRCH/u);
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    expect(unrelated.exitCode).toBeNull();
  } catch (error) {
    failures.push(error);
  } finally {
    // A leader can exit before a failed descendant assertion. Release every known
    // fixture process independently and retain cleanup failures beside the primary error.
    const cleanup = await Promise.allSettled(
      [...ownedPids].map((pid) => terminateWindowsProcessTree(pid, "SIGKILL")),
    );
    for (const result of cleanup) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Owned Windows process tree termination failed (${mode}, ${signal})`,
    );
  }
});

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
        expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
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
