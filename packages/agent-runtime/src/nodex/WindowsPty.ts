import * as NodeNet from "node:net";
import { Worker } from "node:worker_threads";
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
export const waitForWindowsPtyPid = (
  process: import("node-pty").IPty,
  observeExit: (listener: (event: { exitCode: number }) => void) => () => void = (listener) => {
    const subscription = process.onExit(listener);
    return () => subscription.dispose();
  },
) =>
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
    if (socket.destroyed) {
      resume(failure(new Error("Windows PTY closed before its PID was available.")));
      return;
    }
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
    stopExit = observeExit(({ exitCode }) =>
      onError(
        new Error(`Windows PTY exited before its PID was available (exit code ${exitCode}).`),
      ),
    );
    return Effect.sync(cleanup);
  });

/** node-pty forwards public events from the output socket and writes via a separate ConPTY pipe. */
export function observePtyErrors(
  process: import("node-pty").IPty,
  onError: (operation: "read" | "write", cause: NodeJS.ErrnoException) => void,
): void {
  if ("_socket" in process && process._socket instanceof NodeNet.Socket) {
    // node-pty's internal listener throws unless another error listener is present.
    process._socket.on("error", (error: NodeJS.ErrnoException) => {
      // node-pty treats terminal EOF (EIO on POSIX) as ordinary exit.
      if (error.code === "EIO" || error.code === "errno 5") return;
      if (!("_agent" in process) && error.code === "EAGAIN") return;
      onError("read", error);
    });
  }
  const agent = "_agent" in process ? process._agent : undefined;
  if (typeof agent !== "object" || agent === null) return;
  if ("inSocket" in agent && agent.inSocket instanceof NodeNet.Socket) {
    agent.inSocket.on("error", (error) => onError("write", error));
  }
  const connection = "_conoutSocketWorker" in agent ? agent._conoutSocketWorker : undefined;
  if (typeof connection !== "object" || connection === null) return;
  // An uncaught pipe error in node-pty's relay is forwarded to this Worker in Main.
  if ("_worker" in connection && connection._worker instanceof Worker) {
    connection._worker.on("error", (error) => onError("read", error));
  }
}

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
