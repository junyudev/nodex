import { assert, it } from "@effect/vitest";
import * as NodeServices from "./NodeServices";
import nodeChildProcess, { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const processTreeFixture = fileURLToPath(
  new URL("../../../../tests/fixtures/scoped-process-tree.mjs", import.meta.url),
);

for (const release of ["scope", "kill", "pipeline"] as const) {
  it.live.skipIf(process.platform !== "win32")(
    `${release} release waits for Windows descendants and unlocks their executable and cwd`,
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-process-tree-"))),
          (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const executable = path.join(directory, "child.exe");
        yield* Effect.promise(() => copyFile(process.execPath, executable));
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const scope = yield* Scope.make();
        try {
          const command = ChildProcess.make(executable, [processTreeFixture], {
            cwd: directory,
            forceKillAfter: Duration.millis(10),
            windowsHide: true,
            stdin: "ignore",
            stdout: "pipe",
          });
          const handle = yield* spawner
            .spawn(release === "pipeline" ? ChildProcess.pipeTo(command, command) : command)
            .pipe(Effect.provideService(Scope.Scope, scope));
          const ready = yield* handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runHead,
            Effect.timeout("5 seconds"),
          );
          const pids = Option.getOrThrow(ready).split(" ").map(Number);
          assert.strictEqual(pids[0], Number(handle.pid));
          assert.strictEqual(pids.length, 2);
          for (const pid of pids) process.kill(pid, 0);

          if (release === "scope") yield* Scope.close(scope, Exit.void);
          else yield* handle.kill();

          for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/u);
          // No poll, delay, or EBUSY retry: release is the permission to reuse these files.
          yield* Effect.promise(() => rm(directory, { recursive: true }));
        } finally {
          yield* Scope.close(scope, Exit.void);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 20_000 },
  );
}

it.live.each([false, true])("Windows cleanup skips an exited child's PID (signal: %s)", (signal) =>
  Effect.gen(function* () {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const taskkill = vi.spyOn(nodeChildProcess, "execFile").mockImplementation((...args) => {
      const callback = args.at(-1);
      if (typeof callback === "function") callback(null, "", "");
      return new nodeChildProcess.ChildProcess();
    });
    syncBuiltinESMExports();
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const handle = yield* spawner.spawn(
            ChildProcess.make(process.execPath, [
              "-e",
              signal ? "process.kill(process.pid, 'SIGTERM')" : "process.exit(1)",
            ]),
          );
          // Spawn natively, then exercise the Windows exit and release paths.
          Object.defineProperty(process, "platform", { value: "win32" });
          const exit = yield* Effect.exit(handle.exitCode);
          if (signal && platform.value !== "win32") assert.isTrue(Exit.isFailure(exit));
          else assert.strictEqual(Exit.isSuccess(exit) ? Number(exit.value) : undefined, 1);
          yield* handle.kill();
        }),
      );
      assert.strictEqual(taskkill.mock.calls.length, 0);
    } finally {
      Object.defineProperty(process, "platform", platform);
      taskkill.mockRestore();
      syncBuiltinESMExports();
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

/** The process's one-letter state, or undefined once it has been reaped. */
function processState(pid: number): string | undefined {
  if (process.platform === "linux") {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0];
  }
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()[0];
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // An orphan's new parent (a container's PID 1, or launchd) may not reap it
    // immediately, and signal 0 still reaches it until then. Zombies have
    // already exited and cannot execute work or retain the child's resources.
    const state = processState(pid);
    return state !== undefined && state !== "Z";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "ENOENT") return false;
    throw error;
  }
}

function forceCleanup(groupPid: number | undefined): void {
  if (groupPid === undefined) return;
  try {
    process.kill(-groupPid, "SIGKILL");
  } catch (error) {
    // macOS answers EPERM for a group whose members have all exited but are not yet reaped.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || (code === "EPERM" && process.platform === "darwin")) return;
    throw error;
  }
}

it.live.skipIf(process.platform === "win32")(
  "Scope close waits for a process group after its leader exits and escalates a resistant descendant",
  () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const scope = yield* Scope.make();
      let groupPid: number | undefined;

      try {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(process.execPath, [processTreeFixture], {
              detached: true,
              killSignal: "SIGTERM",
              forceKillAfter: Duration.millis(250),
              stdin: "ignore",
              stdout: "pipe",
              stderr: "inherit",
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, scope));
        groupPid = Number(handle.pid);
        const ready = yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
          Effect.timeout("5 seconds"),
        );
        const [leaderPid, descendantPid] = Option.getOrThrow(ready).split(" ").map(Number);
        if (leaderPid === undefined || descendantPid === undefined) {
          return yield* Effect.die(new Error("Process tree did not report both PIDs"));
        }
        assert.strictEqual(leaderPid, groupPid);
        assert.isTrue(Number.isInteger(descendantPid) && descendantPid > 0);
        assert.isTrue(isProcessRunning(descendantPid));

        yield* Scope.close(scope, Exit.void);

        assert.strictEqual(yield* handle.exitCode, 0);
        assert.isFalse(isProcessRunning(leaderPid));
        assert.isFalse(isProcessRunning(descendantPid));
      } finally {
        yield* Scope.close(scope, Exit.void).pipe(
          Effect.ensuring(Effect.sync(() => forceCleanup(groupPid))),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 10_000 },
);
