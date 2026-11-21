import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class BoundedProcessError extends Schema.TaggedError<BoundedProcessError>()(
  "BoundedProcessError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const processError = (message: string, cause?: unknown) =>
  new BoundedProcessError({ message, ...(cause === undefined ? {} : { cause }) });

export interface BoundedProcessInput<E> {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly stdin?: Uint8Array;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** Receives stdout one line at a time; returning false stops the child. */
  readonly onLine?: (line: string) => Effect.Effect<boolean, E>;
  /** Receives NUL-terminated stdout records in batches; returning false stops the child. */
  readonly onPaths?: (paths: readonly string[]) => Effect.Effect<boolean, E>;
}

export interface BoundedProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The caller stopped the child before it exited on its own. */
  readonly stopped: boolean;
}

/** All children and pipe readers belong to the caller's Effect interruption boundary. */
export const runBoundedProcess = <E = never>(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  environment: Readonly<Record<string, string | undefined>>,
  input: BoundedProcessInput<E>,
): Effect.Effect<BoundedProcessResult, BoundedProcessError | E> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(input.executable, [...input.args], {
            cwd: input.cwd,
            env: environment,
            extendEnv: false,
            detached: process.platform !== "win32",
            forceKillAfter: Duration.millis(250),
            stdin: {
              stream: input.stdin ? Stream.make(input.stdin) : Stream.empty,
              endOnDone: true,
            },
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
          }),
        )
        .pipe(Effect.mapError((cause) => processError("Could not start file search", cause)));
      let bytes = 0;
      let stopped = false;
      let stdout = "";
      let stderr = "";
      const bounded = (chunk: Uint8Array) =>
        Effect.suspend(() => {
          bytes += chunk.byteLength;
          return bytes > input.maxBytes
            ? Effect.fail(processError("File search exceeded its output limit"))
            : Effect.void;
        });
      const stdoutStream = child.stdout.pipe(
        Stream.mapError((cause) => processError("Could not read file search output", cause)),
        Stream.tap(bounded),
        Stream.decodeText(),
      );
      const consume = (keepGoing: Effect.Effect<boolean, E>) =>
        Effect.gen(function* () {
          if (stopped || (yield* keepGoing)) return;
          stopped = true;
          yield* child.kill().pipe(Effect.ignore);
        });
      const readStdout = (() => {
        if (input.onPaths) {
          const onPaths = input.onPaths;
          let pending = "";
          return stdoutStream.pipe(
            Stream.runForEach((chunk) => {
              const paths = (pending + chunk).split("\0");
              pending = paths.pop() ?? "";
              return paths.length === 0 ? Effect.void : consume(onPaths(paths));
            }),
          );
        }
        if (input.onLine) {
          const onLine = input.onLine;
          return stdoutStream.pipe(
            Stream.splitLines,
            Stream.runForEach((line) => consume(onLine(line))),
          );
        }
        return stdoutStream.pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              stdout += chunk;
            }),
          ),
        );
      })();
      const [, , code] = yield* Effect.all(
        [
          readStdout,
          child.stderr.pipe(
            Stream.mapError((cause) => processError("Could not read file search errors", cause)),
            Stream.tap(bounded),
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                stderr = (stderr + chunk).slice(0, 65_536);
              }),
            ),
          ),
          child.exitCode.pipe(
            Effect.catchIf(
              () => stopped,
              () => Effect.succeed(0),
            ),
            Effect.mapError((cause) => processError("File search process failed", cause)),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return { code: Number(code), stdout, stderr, stopped };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(input.timeoutMs),
      orElse: () => Effect.fail(processError("File search timed out")),
    }),
  );
