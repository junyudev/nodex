import * as NodeServices from "@effect/platform-node/NodeServices";
import { StringDecoder } from "node:string_decoder";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  GitCommandPlatform,
  type GitCommandProcessFailureReason,
  type GitCommandProcessInput,
  type GitCommandProcessResult,
} from "../../git-worker/git-command-platform";

const GIT_KILL_ESCALATION_MS = 250;

class GitCommandProcessError extends Data.TaggedError("GitCommandProcessError")<{
  readonly reason: GitCommandProcessFailureReason;
  readonly cause?: unknown;
}> {}

interface OutputState {
  readonly stdout: string[];
  readonly stderr: string[];
  retainedBytes: number;
  stdoutDeliveredBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
}

const processError = (
  reason: GitCommandProcessFailureReason,
  cause?: unknown,
): GitCommandProcessError =>
  new GitCommandProcessError({ reason, ...(cause === undefined ? {} : { cause }) });

function finishOutput(
  state: OutputState,
  stdoutDecoder: StringDecoder | null,
  stderrDecoder: StringDecoder,
  code: number | null,
  failureReason: GitCommandProcessFailureReason | null,
): GitCommandProcessResult {
  if (stdoutDecoder) state.stdout.push(stdoutDecoder.end());
  state.stderr.push(stderrDecoder.end());
  return {
    code,
    signal: null,
    stdout: state.stdout.join(""),
    stderr: state.stderr.join(""),
    stdoutBytes: state.stdoutBytes,
    stderrBytes: state.stderrBytes,
    failureReason,
  };
}

const runGitProcess = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: GitCommandProcessInput,
): Effect.Effect<GitCommandProcessResult> =>
  Effect.suspend(() => {
    const state: OutputState = {
      stdout: [],
      stderr: [],
      retainedBytes: 0,
      stdoutDeliveredBytes: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    const stdoutDecoder = input.stdoutStream ? null : new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const stdin =
      input.stdin === undefined
        ? Stream.empty
        : Stream.make(
            typeof input.stdin === "string"
              ? new TextEncoder().encode(input.stdin)
              : new Uint8Array(input.stdin),
          );
    const command = ChildProcess.make("git", [...input.args], {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: { ...input.environment },
      extendEnv: false,
      forceKillAfter: Duration.millis(GIT_KILL_ESCALATION_MS),
      killSignal: "SIGTERM",
      stdin: { stream: stdin, endOnDone: true },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const append = (
      stream: "stdout" | "stderr",
      decoder: StringDecoder | null,
      chunk: Uint8Array,
    ): Effect.Effect<void, GitCommandProcessError> =>
      Effect.try({
        try: () => {
          if (stream === "stdout") state.stdoutBytes += chunk.byteLength;
          else state.stderrBytes += chunk.byteLength;

          const streamLimit =
            stream === "stdout" && input.stdoutStream
              ? input.stdoutStream.maxBytes
              : input.outputBytesCap;
          const consumedBytes =
            stream === "stdout" && input.stdoutStream
              ? state.stdoutDeliveredBytes
              : state.retainedBytes;
          const remaining = streamLimit === null ? chunk.byteLength : streamLimit - consumedBytes;
          const acceptedLength = Math.max(0, Math.min(chunk.byteLength, remaining));
          const accepted =
            acceptedLength === chunk.byteLength ? chunk : chunk.subarray(0, acceptedLength);

          if (accepted.byteLength > 0 && stream === "stdout" && input.stdoutStream) {
            input.stdoutStream.onChunk(accepted);
            state.stdoutDeliveredBytes += accepted.byteLength;
          } else if (accepted.byteLength > 0) {
            state[stream].push(decoder?.write(Buffer.from(accepted)) ?? "");
            state.retainedBytes += accepted.byteLength;
          }
          return acceptedLength === chunk.byteLength;
        },
        catch: (cause) => processError("wait_failed", cause),
      }).pipe(
        Effect.flatMap((complete) =>
          complete ? Effect.void : Effect.fail(processError("output_limit")),
        ),
      );
    const attempt = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(command)
          .pipe(Effect.mapError((cause) => processError("spawn_failed", cause)));
        const [, , exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(
              Stream.mapError((cause) => processError("wait_failed", cause)),
              Stream.runForEach((chunk) => append("stdout", stdoutDecoder, chunk)),
            ),
            handle.stderr.pipe(
              Stream.mapError((cause) => processError("wait_failed", cause)),
              Stream.runForEach((chunk) => append("stderr", stderrDecoder, chunk)),
            ),
            handle.exitCode.pipe(Effect.mapError((cause) => processError("wait_failed", cause))),
          ],
          { concurrency: "unbounded" },
        );
        return Number(exitCode);
      }),
    );
    const bounded =
      input.timeoutMs === null
        ? attempt
        : attempt.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(input.timeoutMs),
              orElse: () => Effect.fail(processError("timed_out")),
            }),
          );
    return bounded.pipe(
      Effect.map((code) => finishOutput(state, stdoutDecoder, stderrDecoder, code, null)),
      Effect.catch((error) =>
        Effect.succeed(finishOutput(state, stdoutDecoder, stderrDecoder, null, error.reason)),
      ),
    );
  });

export const live: Layer.Layer<GitCommandPlatform, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    GitCommandPlatform,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return GitCommandPlatform.of({
        run: (input) => runGitProcess(spawner, input),
      });
    }),
  );

export const nodeLive: Layer.Layer<GitCommandPlatform> = live.pipe(
  Layer.provide(NodeServices.layer),
);
