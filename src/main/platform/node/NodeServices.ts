import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { terminateWindowsProcessTree } from "../../process-tree";

export type { NodeServices } from "@effect/platform-node/NodeServices";

function pipeInput(
  command: ChildProcess.Command,
  stream: ChildProcessSpawner.ChildProcessHandle["stdout"],
  to: NonNullable<ChildProcess.PipeOptions["to"]>,
): ChildProcess.Command {
  if (command._tag === "PipedCommand") {
    return ChildProcess.pipeTo(pipeInput(command.left, stream, to), command.right, command.options);
  }
  return ChildProcess.make(
    command.command,
    command.args,
    to === "stdin"
      ? { ...command.options, stdin: { stream, endOnDone: true } }
      : {
          ...command.options,
          additionalFds: { ...command.options.additionalFds, [to]: { type: "input", stream } },
        },
  );
}

const supervisedSpawner = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const native = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawn: typeof native.spawn = Effect.fnUntraced(function* (command) {
      if (process.platform !== "win32") return yield* native.spawn(command);
      if (command._tag === "PipedCommand") {
        const left = yield* spawn(command.left);
        const from = command.options.from ?? "stdout";
        const source =
          from === "all"
            ? left.all
            : from === "stderr"
              ? left.stderr
              : from === "stdout"
                ? left.stdout
                : left.getOutputFd(Number(from.slice(2)));
        const to = command.options.to ?? "stdin";
        const right = yield* spawn(pipeInput(command.right, source, to));
        return ChildProcessSpawner.makeHandle({
          ...right,
          stdin: left.stdin,
          kill: (options) =>
            Effect.all([right.kill(options), left.kill(options)], { discard: true }),
          unref: Effect.gen(function* () {
            const rerefLeft = yield* left.unref;
            const rerefRight = yield* right.unref;
            // @effect-diagnostics-next-line returnEffectInGen:off -- unref returns the re-reference Effect.
            return Effect.andThen(rerefRight, rerefLeft);
          }),
        });
      }
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const handle = yield* native.spawn(command);
          let referenced = true;
          const kill = (options: ChildProcess.KillOptions = command.options) =>
            Effect.gen(function* () {
              // Never send a stale PID to an external terminator after native exit.
              if (!(yield* handle.isRunning)) return;
              yield* Effect.tryPromise({
                try: () =>
                  terminateWindowsProcessTree(
                    Number(handle.pid),
                    options.killSignal ?? "SIGTERM",
                    options.forceKillAfter === undefined
                      ? 250
                      : Duration.toMillis(options.forceKillAfter),
                  ),
                catch: (cause) =>
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "ChildProcess",
                    method: "kill",
                    cause,
                    description: "Could not release the child process tree",
                  }),
              });
              yield* Effect.ignore(handle.exitCode);
            }).pipe(Effect.uninterruptible);
          // Registered after native acquisition, so this runs before its best-effort release.
          yield* Effect.addFinalizer(() => (referenced ? kill().pipe(Effect.orDie) : Effect.void));
          return ChildProcessSpawner.makeHandle({
            ...handle,
            kill,
            unref: Effect.gen(function* () {
              const reref = yield* handle.unref;
              referenced = false;
              // @effect-diagnostics-next-line returnEffectInGen:off -- unref returns the re-reference Effect.
              return Effect.tap(reref, () =>
                Effect.sync(() => {
                  referenced = true;
                }),
              );
            }),
          });
        }),
      );
    });
    return ChildProcessSpawner.make(spawn);
  }),
);

/** Main's process capability keeps native POSIX behavior and awaits Windows tree release. */
export const layer: Layer.Layer<NodeServices.NodeServices> = supervisedSpawner.pipe(
  Layer.provideMerge(NodeServices.layer),
);
