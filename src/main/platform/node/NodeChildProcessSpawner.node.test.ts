import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return true;
    // A container's PID 1 may not reap an orphan immediately. Zombies have
    // already exited and cannot execute work or retain the child's resources.
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0];
    return state !== "Z";
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
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
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
