import { MainConfig } from "../../app/MainConfig";
import { killWindowsPty, waitForWindowsPtyPid } from "@nodex/agent-runtime/windows-pty";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  TERMINAL_OUTPUT_CHUNK_CAPACITY,
  TERMINAL_OUTPUT_CHUNK_CHAR_LIMIT,
} from "../../runtime-limits";
import * as Stream from "effect/Stream";
import * as pty from "node-pty";

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
  readonly output: Stream.Stream<string>;
  readonly exit: Effect.Effect<TerminalPtyExit>;
  readonly write: (data: string) => Effect.Effect<void, TerminalPtyError>;
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, TerminalPtyError>;
  readonly kill: Effect.Effect<void, TerminalPtyError>;
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
          const output = yield* Queue.sliding<string>(TERMINAL_OUTPUT_CHUNK_CAPACITY);
          const exit = yield* Deferred.make<TerminalPtyExit>();
          const runCallback = yield* FiberSet.makeRuntime();
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
                // Install callbacks in the same native acquisition so an immediate exit is retained.
                const dataSubscription = native.onData((data) =>
                  runCallback(
                    Queue.offer(output, data.slice(-TERMINAL_OUTPUT_CHUNK_CHAR_LIMIT)).pipe(
                      Effect.asVoid,
                    ),
                  ),
                );
                const exitSubscription = native.onExit(({ exitCode, signal }) =>
                  runCallback(
                    Deferred.succeed(exit, {
                      exitCode: Number.isFinite(exitCode) ? exitCode : null,
                      signal: typeof signal === "number" && Number.isFinite(signal) ? signal : null,
                    }).pipe(Effect.asVoid),
                  ),
                );
                return { native, dataSubscription, exitSubscription };
              },
              catch: (cause) => ptyError("spawn", cause),
            }),
            ({ native, dataSubscription, exitSubscription }) =>
              Effect.sync(() => {
                dataSubscription.dispose();
                exitSubscription.dispose();
                try {
                  terminate(native);
                } catch {
                  /* The process may already have exited. */
                }
              }).pipe(
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
            output: Stream.fromQueue(output),
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
            kill: Effect.try({
              try: () => terminate(process.native),
              catch: (cause) => ptyError("kill", cause),
            }),
          };
        }),
    });
  }),
);
