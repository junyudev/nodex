import { observeChildStdioErrors } from "../platform/node/child-stdio-errors";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import {
  type WorktreeWorkerProcess,
  makeWorktreeWorkerClient,
  type WorktreeWorkerRuntime,
  WorktreeWorkerProcessStartError,
} from "../host-runtime/WorktreeWorkerRuntime";
import {
  validateOutgoingCodexWorktreeWorkerHostMessage,
  type CodexWorktreeWorkerHostMessage,
} from "../worktree-worker/worktree-worker-protocol";

export class CodexRemoteExecutionUnknownStateError extends Error {
  readonly code = "remote-execution-state-unknown" as const;
  readonly hostId: string;

  constructor(
    hostId: string,
    message = "Remote execution state is unknown after the SSH connection closed",
  ) {
    super(message);
    this.name = "CodexRemoteExecutionUnknownStateError";
    this.hostId = hostId;
  }
}

export interface CodexRemoteWorktreeWorkerOptions {
  readonly hostId: string;
  readonly openWorker: (signal: AbortSignal) => Promise<ChildProcessWithoutNullStreams>;
  readonly onInfrastructureError?: (error: Error) => void;
  readonly shutdownTimeoutMs?: number;
}

const exitCode = (code: number | null, signal: NodeJS.Signals | null): number => {
  if (code !== null) return code;
  return signal === null ? 1 : 128;
};

/** Converts one SSH child into the framing-only process seam used by the scoped client. */
const makeProcess = (
  hostId: string,
  child: ChildProcessWithoutNullStreams,
): WorktreeWorkerProcess => {
  let failure: Error | undefined;
  let notify: ((error: Error) => void) | undefined;
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    notify?.(error);
  };
  child.on("error", fail);
  observeChildStdioErrors(child, fail);
  child.stderr.resume();
  return {
    send: (message: CodexWorktreeWorkerHostMessage) => {
      const validated = validateOutgoingCodexWorktreeWorkerHostMessage(message);
      if (failure) throw failure;
      if (child.stdin.destroyed) throw new CodexRemoteExecutionUnknownStateError(hostId);
      child.stdin.write(`${JSON.stringify(validated)}\n`);
    },
    onMessage: (listener) => {
      let buffer = "";
      child.stdout.setEncoding("utf8");
      const onData = (chunk: string): void => {
        buffer += chunk;
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            listener(JSON.parse(line) as unknown);
          } catch {
            listener(null);
          }
        }
      };
      child.stdout.on("data", onData);
      return () => child.stdout.off("data", onData);
    },
    onError: (listener) => {
      notify = listener;
      if (failure) listener(failure);
      return () => {
        notify = undefined;
      };
    },
    onExit: (listener) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        listener(exitCode(code, signal));
      };
      child.on("exit", onExit);
      return () => child.off("exit", onExit);
    },
    terminate: () =>
      new Promise<number>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(exitCode(child.exitCode, child.signalCode));
          return;
        }
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          resolve(exitCode(code, signal));
        };
        child.once("exit", onExit);
        if (child.kill("SIGKILL")) return;
        child.off("exit", onExit);
        resolve(exitCode(child.exitCode, child.signalCode));
      }),
  };
};

/**
 * Acquires the remote worker capability inside the caller's Scope. Reconnect, pending requests,
 * cancellation and child termination remain private to the shared Effect worker client.
 */
export const makeCodexRemoteWorktreeWorker = (
  options: CodexRemoteWorktreeWorkerOptions,
): Effect.Effect<WorktreeWorkerRuntime["Service"], never, Scope.Scope> =>
  makeWorktreeWorkerClient({
    hostId: options.hostId,
    createProcess: () =>
      Effect.tryPromise({
        try: (signal) =>
          options.openWorker(signal).then((child) => makeProcess(options.hostId, child)),
        catch: (cause) => new WorktreeWorkerProcessStartError({ cause }),
      }),
    // Each remote process is a fresh protocol generation even when the host client reconnects.
    expectedReadyEpoch: () => 1,
    onInfrastructureError: options.onInfrastructureError,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  });
