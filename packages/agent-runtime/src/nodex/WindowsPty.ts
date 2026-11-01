import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WindowsPtyStartupError extends Schema.TaggedError<WindowsPtyStartupError>()(
  "WindowsPtyStartupError",
  { message: Schema.String },
) {}

/**
 * node-pty defers creation to avoid blocking on named pipes:
 * https://github.com/microsoft/node-pty/pull/885 Its public API has no
 * readiness event. The private ready_datapipe handler sets pid before our
 * listener runs.
 */
export const waitForWindowsPtyPid = (process: import("node-pty").IPty) =>
  Effect.callback<void, WindowsPtyStartupError>((resume) => {
    const hasPid = () => Number.isInteger(process.pid) && process.pid > 0;
    const failure = (cause: unknown) =>
      Effect.fail(
        new WindowsPtyStartupError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );

    if (hasPid()) {
      resume(Effect.void);
      return;
    }

    if (!("_socket" in process) || !(process._socket instanceof NodeNet.Socket)) {
      resume(failure(new Error("Windows PTY readiness socket is unavailable.")));
      return;
    }

    const socket = process._socket;
    const onReady = () => {
      cleanup();
      resume(
        hasPid()
          ? Effect.void
          : failure(new Error("Windows PTY became ready without a valid PID.")),
      );
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(failure(cause));
    };
    const onClose = () => onError(new Error("Windows PTY closed before its PID was available."));
    let stopExit = () => {};
    const cleanup = () => {
      socket.off("ready_datapipe", onReady);
      socket.off("error", onError);
      socket.off("close", onClose);
      stopExit();
    };
    socket.once("ready_datapipe", onReady);
    socket.once("error", onError);
    socket.once("close", onClose);
    const exit = process.onExit(({ exitCode }) =>
      onError(
        new Error(`Windows PTY exited before its PID was available (exit code ${exitCode}).`),
      ),
    );
    stopExit = () => exit.dispose();
    return Effect.sync(cleanup);
  });

/** Cancel ConPTY startup immediately; public kill can wait for the pending pipe connection. */
export function killWindowsPty(process: import("node-pty").IPty): void {
  if (
    "_agent" in process &&
    typeof process._agent === "object" &&
    process._agent !== null &&
    "kill" in process._agent &&
    typeof process._agent.kill === "function"
  ) {
    process._agent.kill();
    return;
  }
  process.kill();
}
