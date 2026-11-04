import { MainConfig } from "../../app/MainConfig";
import { killWindowsPty, waitForWindowsPtyPid } from "@nodex/agent-runtime/windows-pty";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as pty from "node-pty";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TERMINAL_OUTPUT_CHUNK_CAPACITY } from "../../runtime-limits";
import { collectDescendantPids, parseUnixProcessTreeOutput } from "../../terminal-process-metrics";

export class TerminalPtyError extends Schema.TaggedError<TerminalPtyError>()("TerminalPtyError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface TerminalPtyConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalPtyExit {
  readonly exitCode: number | null;
  readonly signal: number | null;
}

export interface TerminalPtyHandle {
  readonly pid: number;
  /** Ends after the last native data callback on process exit. */
  readonly output: Stream.Stream<string>;
  readonly exit: Effect.Effect<TerminalPtyExit>;
  readonly write: (data: string) => Effect.Effect<void, TerminalPtyError>;
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, TerminalPtyError>;
  readonly kill: Effect.Effect<void, TerminalPtyError>;
  readonly prepareForRestart: Effect.Effect<void>;
}

export class TerminalPty extends Context.Service<
  TerminalPty,
  {
    readonly spawn: (
      config: TerminalPtyConfig,
    ) => Effect.Effect<TerminalPtyHandle, TerminalPtyError, Scope.Scope>;
  }
>()("nodex/main/platform/node/TerminalPty") {}

const ptyError = (operation: string, cause: unknown) => new TerminalPtyError({ operation, cause });

const execFileAsync = promisify(execFile);

async function killDarwinPtyTree(native: pty.IPty): Promise<void> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-ax", "-o", "pid=,ppid="], {
      timeout: 5_000,
    });
    const descendants = collectDescendantPids(parseUnixProcessTreeOutput(stdout), [
      { pid: native.pid, includeRoot: false },
    ]);
    let failure: unknown;
    for (const pid of descendants.reverse()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  } finally {
    native.kill("SIGKILL");
  }
}

export const live = Layer.effect(
  TerminalPty,
  Effect.gen(function* () {
    const hostConfig = yield* MainConfig;
    const terminate = (process: pty.IPty) => {
      if (hostConfig.platform === "win32") {
        killWindowsPty(process);
        return;
      }
      process.kill();
    };
    return TerminalPty.of({
      spawn: (config) =>
        Effect.gen(function* () {
          const output = yield* Queue.bounded<string, Cause.Done>(TERMINAL_OUTPUT_CHUNK_CAPACITY);
          const exit = yield* Deferred.make<TerminalPtyExit>();
          const runCallback = yield* FiberSet.makeRuntime();
          let pendingOffers = 0;
          let restarting = false;
          let paused = false;
          let exited = false;
          const process = yield* Effect.acquireRelease(
            Effect.try({
              try: () => {
                const native = pty.spawn(config.command, [...config.args], {
                  name: "xterm-256color",
                  cols: config.cols,
                  rows: config.rows,
                  cwd: config.cwd,
                  env: { ...config.env },
                });
                const dataSubscription = native.onData((data) => {
                  // A read in flight when the stream pauses waits in line, so output never reorders.
                  if (pendingOffers > 0 || !Queue.offerUnsafe(output, data)) {
                    pendingOffers += 1;
                    runCallback(
                      Queue.offer(output, data).pipe(
                        Effect.ensuring(
                          Effect.sync(() => {
                            pendingOffers -= 1;
                          }),
                        ),
                      ),
                    );
                  }
                  if (paused || !Queue.isFullUnsafe(output)) return;
                  paused = true;
                  native.pause();
                });
                const exitSubscription = native.onExit(({ exitCode, signal }) => {
                  exited = true;
                  Deferred.doneUnsafe(
                    exit,
                    Effect.succeed({
                      exitCode: Number.isFinite(exitCode) ? exitCode : null,
                      signal: typeof signal === "number" && Number.isFinite(signal) ? signal : null,
                    }),
                  );
                  Queue.endUnsafe(output);
                });
                return { native, dataSubscription, exitSubscription };
              },
              catch: (cause) => ptyError("spawn", cause),
            }),
            ({ native, dataSubscription, exitSubscription }) =>
              Effect.sync(() => {
                dataSubscription.dispose();
                exitSubscription.dispose();
              }).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (restarting && hostConfig.platform === "darwin") {
                      return Effect.tryPromise({
                        try: () => killDarwinPtyTree(native),
                        catch: (cause) => ptyError("restart", cause),
                      }).pipe(
                        Effect.catch((error) =>
                          Effect.logWarning(
                            "Could not terminate all processes in the old terminal",
                            error,
                          ),
                        ),
                      );
                    }
                    return Effect.sync(() => {
                      try {
                        terminate(native);
                      } catch {
                        /* The process may already have exited. */
                      }
                    });
                  }),
                ),
                Effect.andThen(Queue.shutdown(output)),
                Effect.andThen(Deferred.succeed(exit, { exitCode: null, signal: null })),
                Effect.asVoid,
              ),
          );
          if (hostConfig.platform === "win32")
            yield* waitForWindowsPtyPid(process.native).pipe(
              Effect.mapError((cause) => ptyError("spawn", cause)),
              Effect.raceFirst(
                Deferred.await(exit).pipe(
                  Effect.flatMap(({ exitCode }) =>
                    Effect.fail(
                      ptyError(
                        "spawn",
                        new Error(
                          `Windows PTY exited before its PID was available (exit code ${exitCode}).`,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
          return {
            pid: process.native.pid,
            output: Stream.fromQueue(output).pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  if (
                    !paused ||
                    exited ||
                    Queue.sizeUnsafe(output) > TERMINAL_OUTPUT_CHUNK_CAPACITY / 2
                  )
                    return;
                  paused = false;
                  process.native.resume();
                }),
              ),
            ),
            exit: Deferred.await(exit),
            write: (data) =>
              Effect.try({
                try: () => process.native.write(data),
                catch: (cause) => ptyError("write", cause),
              }),
            resize: (cols, rows) =>
              Effect.try({
                try: () => process.native.resize(cols, rows),
                catch: (cause) => ptyError("resize", cause),
              }),
            prepareForRestart: Effect.sync(() => {
              restarting = true;
            }),
            kill: Effect.try({
              try: () => terminate(process.native),
              catch: (cause) => ptyError("kill", cause),
            }),
          };
        }),
    });
  }),
);
