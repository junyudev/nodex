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

export const live: Layer.Layer<TerminalPty> = Layer.succeed(
  TerminalPty,
  TerminalPty.of({
    spawn: (config) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const output = yield* Queue.sliding<string>(TERMINAL_OUTPUT_CHUNK_CAPACITY);
          const exit = yield* Deferred.make<TerminalPtyExit>();
          const runCallback = yield* FiberSet.makeRuntime();
          const process = yield* Effect.try({
            try: () =>
              pty.spawn(config.command, [...config.args], {
                name: "xterm-256color",
                cols: config.cols,
                rows: config.rows,
                cwd: config.cwd,
                env: { ...config.env },
              }),
            catch: (cause) => ptyError("spawn", cause),
          });
          const dataSubscription = process.onData((data) => {
            const bounded = data.slice(-TERMINAL_OUTPUT_CHUNK_CHAR_LIMIT);
            runCallback(Queue.offer(output, bounded).pipe(Effect.asVoid));
          });
          const exitSubscription = process.onExit(({ exitCode, signal }) => {
            const normalizedSignal =
              typeof signal === "number" && Number.isFinite(signal) ? signal : null;
            runCallback(
              Deferred.succeed(exit, {
                exitCode: Number.isFinite(exitCode) ? exitCode : null,
                signal: normalizedSignal,
              }).pipe(Effect.asVoid),
            );
          });
          return { process, output, exit, dataSubscription, exitSubscription };
        }),
        ({ process, output, exit, dataSubscription, exitSubscription }) =>
          Effect.sync(() => {
            dataSubscription.dispose();
            exitSubscription.dispose();
            try {
              process.kill();
            } catch {
              // The PTY can exit between the final state check and its scope finalizer.
            }
          }).pipe(
            Effect.andThen(Queue.shutdown(output)),
            Effect.andThen(
              Deferred.succeed(exit, {
                exitCode: null,
                signal: null,
              }),
            ),
            Effect.asVoid,
          ),
      ).pipe(
        Effect.map(({ process, output, exit }) => ({
          pid: process.pid,
          output: Stream.fromQueue(output),
          exit: Deferred.await(exit),
          write: (data) =>
            Effect.try({
              try: () => process.write(data),
              catch: (cause) => ptyError("write", cause),
            }),
          resize: (cols, rows) =>
            Effect.try({
              try: () => process.resize(cols, rows),
              catch: (cause) => ptyError("resize", cause),
            }),
          kill: Effect.try({
            try: () => process.kill(),
            catch: (cause) => ptyError("kill", cause),
          }),
        })),
      ),
  }),
);
