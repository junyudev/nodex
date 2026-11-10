/* @effect-diagnostics asyncFunction:off -- Verifies an owned native process tree, including Windows taskkill. */
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vite-plus/test";
import { runCodexGitCommand } from "./codex/codex-git-command";
import {
  signalPosixChildProcessTree,
  terminateWindowsProcessTree,
  WindowsProcessTreeReleaseError,
} from "./process-tree";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawn: vi.fn(actual.spawn) };
});

test.each([false, true])(
  "keeps the owner responsive until native Windows release settles (failed=%s)",
  async (releaseFailed) => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const fixture = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const nativeFailure = new Error("Native process handles remain unsignaled");
    let complete = () => {};
    let observed: Promise<void> | undefined;
    let failure: unknown;
    try {
      await once(fixture, "spawn");
      vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
        const callback = args[3];
        if (typeof callback !== "function") throw new Error("Expected native completion callback");
        complete = () => callback(releaseFailed ? nativeFailure : null, "", "");
        return fixture;
      }) as typeof execFile);
      let completed = false;
      observed = terminateWindowsProcessTree(fixture.pid!, "SIGTERM").then(
        () => {
          completed = true;
        },
        (error: unknown) => {
          failure = error;
        },
      );
      // The native Adapter remains pending while ordinary owner callbacks can run.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(failure).toBeUndefined();
      expect(completed).toBe(false);
      complete();
      await observed;
      if (releaseFailed) {
        expect(completed).toBe(false);
        expect(failure).toBeInstanceOf(WindowsProcessTreeReleaseError);
        expect((failure as WindowsProcessTreeReleaseError).cause).toBe(nativeFailure);
        expect((failure as WindowsProcessTreeReleaseError).pid).toBe(fixture.pid);
      } else {
        expect(failure).toBeUndefined();
        expect(completed).toBe(true);
      }
    } finally {
      complete();
      await observed;
      vi.mocked(execFile).mockReset().mockImplementation(actual.execFile);
      if (fixture.exitCode === null && fixture.signalCode === null && fixture.pid !== undefined) {
        const exited = once(fixture, "exit");
        fixture.kill("SIGKILL");
        await exited;
      }
    }
  },
);

test.runIf(process.platform === "win32")(
  "fences Git output after native release failure while owning streams until physical close",
  async ({ signal }) => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const fixture = actual.spawn(
      process.execPath,
      ["-e", 'process.on("message", () => process.stdout.write("after-terminal\\n"))'],
      { stdio: ["pipe", "pipe", "pipe", "ipc"] },
    );
    const closed = new Promise<void>((resolve) => {
      fixture.once("close", () => resolve());
    });
    const controller = new AbortController();
    const nativeFailure = new Error("Native process handles remain unsignaled");
    const output: string[] = [];
    let complete = () => {};
    let operation: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      const { stdout, stderr } = fixture;
      if (!stdout || !stderr) throw new Error("Expected piped Git output streams");
      await once(fixture, "spawn", { signal });
      vi.mocked(spawn).mockReturnValueOnce(fixture);
      vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
        const callback = args[3];
        if (typeof callback !== "function") throw new Error("Expected native completion callback");
        complete = () => callback(nativeFailure, "", "");
        return fixture;
      }) as typeof execFile);
      operation = runCodexGitCommand(["--version"], tmpdir(), {
        signal: controller.signal,
        onOutput: ({ data }) => output.push(data),
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      controller.abort();
      complete();
      const result = await operation;
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") throw new Error("Expected failed native release");
      expect(result.reason).toBeInstanceOf(WindowsProcessTreeReleaseError);
      expect((result.reason as Error).cause).toBe(nativeFailure);
      expect(fixture.exitCode).toBeNull();
      expect(stdout.listenerCount("data")).toBeGreaterThan(0);
      expect(fixture.listenerCount("error")).toBeGreaterThan(0);
      // Git owns stdin and closes it at launch. Trigger late output independently.
      const lateOutput = once(stdout, "data", { signal });
      fixture.send("write");
      await lateOutput;
      expect(output).toEqual([]);
      expect(() => fixture.emit("error", new Error("late owned Git error"))).not.toThrow();
      fixture.kill("SIGKILL");
      await closed;
      expect(stdout.listenerCount("data")).toBe(0);
      expect(stderr.listenerCount("data")).toBe(0);
      expect(fixture.listenerCount("error")).toBe(0);
      expect(fixture.listenerCount("close")).toBe(0);
    } finally {
      complete();
      if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGKILL");
      await closed;
      await operation;
      vi.mocked(execFile).mockReset().mockImplementation(actual.execFile);
      vi.mocked(spawn).mockReset().mockImplementation(actual.spawn);
    }
  },
);

test.runIf(process.platform === "win32").each(["SIGTERM", "SIGKILL"] as const)(
  "terminates only the owned Windows console tree (%s)",
  async (signal) => {
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
      expect(() => signalPosixChildProcessTree(child, signal)).toThrow("must be awaited");
      await terminateWindowsProcessTree(child.pid!, signal);
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
        `Owned Windows process tree termination failed (${signal})`,
      );
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
        [
          "-c",
          // This fixture selects Electron's Node mode explicitly; Git does not inherit it.
          `alias.nodex-tree=!ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(fixture)}`,
          "nodex-tree",
        ],
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
