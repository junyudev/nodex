import { spawn } from "node:child_process";
import {
  hasWindowsProcessTreeReleaseFailure,
  signalPosixChildProcessTree,
  terminateWindowsProcessTree,
} from "../process-tree";

export interface CodexGitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type CodexGitCommandOutputStream = "stdout" | "stderr" | "info";

const NON_GIT_REPOSITORY_MESSAGES = [
  "not a git repository",
  "cannot use bare repository",
  "invalid gitfile format",
  "no path in gitfile",
  "invalid gitdir",
] as const;

export function isCodexNonGitRepositoryMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return NON_GIT_REPOSITORY_MESSAGES.some((candidate) => normalized.includes(candidate));
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const KILL_ESCALATION_MS = 250;

export class CodexRequestCanceledError extends Error {
  constructor(message = "Request canceled") {
    super(message);
    this.name = "CodexRequestCanceledError";
  }
}

export function createCodexRequestCanceledError(message?: string): CodexRequestCanceledError {
  return new CodexRequestCanceledError(message);
}

export function isCodexRequestCanceledError(error: unknown, signal?: AbortSignal): boolean {
  return (
    error instanceof CodexRequestCanceledError ||
    (signal?.aborted === true && error === signal.reason)
  );
}

/** A fallback must not erase a failed release or replace an interrupted operation's outcome. */
export function throwIfCodexGitRecoveryUnsafe(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted || hasWindowsProcessTreeReleaseFailure(error)) throw error;
}

/** Join concurrent Git owners before publishing cancellation or choosing a recovery path. */
export async function joinCodexGitOperations<const T extends readonly unknown[]>(operations: {
  [K in keyof T]: Promise<T[K]>;
}): Promise<T> {
  const outcomes = await Promise.allSettled(operations);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as unknown] : [],
  );
  if (
    failures.length === 1 ||
    (failures.length > 1 && failures.every((error) => isCodexRequestCanceledError(error)))
  )
    throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Concurrent Git operations failed");
  return outcomes.map((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  }) as unknown as T;
}

export function throwIfCodexRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createCodexRequestCanceledError();
}

/** Runs Git without a shell and reaps its entire process group after cancel/timeout. */
export function runCodexGitCommand(
  args: readonly string[],
  cwd: string,
  options?: {
    readonly allowedExitCodes?: readonly number[];
    readonly env?: NodeJS.ProcessEnv;
    readonly maxOutputBytes?: number;
    readonly onOutput?: (output: {
      readonly stream: CodexGitCommandOutputStream;
      readonly data: string;
    }) => void;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<CodexGitCommandResult> {
  const allowedExitCodes = options?.allowedExitCodes ?? [0];
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const signal = options?.signal;
  const timeoutMs = options?.timeoutMs;
  throwIfCodexRequestAborted(signal);

  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      env: options?.env ?? process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let aborted = false;
    let timedOut = false;
    let exceededOutputBound = false;
    let settled = false;
    let childError: Error | null = null;
    let killEscalationId: ReturnType<typeof setTimeout> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let windowsTermination: Promise<void> | null = null;

    const cleanup = () => {
      if (killEscalationId) clearTimeout(killEscalationId);
      if (timeoutId) clearTimeout(timeoutId);
      signal?.removeEventListener("abort", handleAbort);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const rejectTermination = (cause: unknown) =>
      rejectOnce(cause instanceof Error ? cause : new Error(String(cause)));
    const settleAfterTermination = (complete: () => void) => {
      if (!windowsTermination) {
        complete();
        return;
      }
      void windowsTermination.then(complete, rejectTermination);
    };
    const terminate = () => {
      if (windowsTermination || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") {
        if (child.pid === undefined) return;
        // Keep draining Git's pipes while native handles settle, then publish its outcome.
        windowsTermination = terminateWindowsProcessTree(child.pid);
        void windowsTermination.catch(rejectTermination);
        return;
      }
      signalPosixChildProcessTree(child, "SIGTERM");
      if (killEscalationId) return;
      killEscalationId = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          signalPosixChildProcessTree(child, "SIGKILL");
        }
      }, KILL_ESCALATION_MS);
      killEscalationId.unref();
    };
    function handleAbort(): void {
      aborted = true;
      terminate();
    }
    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (settled || exceededOutputBound) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        exceededOutputBound = true;
        terminate();
        return;
      }
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      options?.onOutput?.({ stream, data: text });
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
    if (timeoutMs != null) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeoutId.unref();
    }

    const handleStdout = (chunk: Buffer): void => appendOutput("stdout", chunk);
    const handleStderr = (chunk: Buffer): void => appendOutput("stderr", chunk);
    child.stdout?.on("data", handleStdout);
    child.stderr?.on("data", handleStderr);
    const finishClose = (code: number | null) => {
      if (settled) return;
      if (childError) {
        rejectOnce(childError);
        return;
      }
      if (aborted || signal?.aborted) {
        rejectOnce(createCodexRequestCanceledError());
        return;
      }
      if (timedOut) {
        rejectOnce(new Error(`Git command timed out after ${String(timeoutMs)}ms`));
        return;
      }
      if (exceededOutputBound) {
        rejectOnce(new Error(`Git command exceeded ${String(maxOutputBytes)} output bytes`));
        return;
      }
      if (code != null && allowedExitCodes.includes(code)) {
        settled = true;
        cleanup();
        resolve({ stdout, stderr });
        return;
      }
      const message = stderr.trim() || stdout.trim() || `git exited with code ${String(code)}`;
      rejectOnce(new Error(message));
    };
    const handleError = (error: Error): void => {
      if (!settled) childError = error;
    };
    const handleClose = (code: number | null): void => {
      child.stdout?.off("data", handleStdout);
      child.stderr?.off("data", handleStderr);
      child.off("error", handleError);
      child.off("close", handleClose);
      settleAfterTermination(() => finishClose(code));
    };
    child.on("error", handleError);
    child.once("close", handleClose);
  });
}
