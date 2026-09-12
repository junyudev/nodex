import { spawn, type ChildProcess } from "node:child_process";

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

export function createCodexRequestCanceledError(): Error {
  return new Error("Request canceled");
}

export function throwIfCodexRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createCodexRequestCanceledError();
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform !== "win32" && pid != null) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The process group may already have exited or may not have been created.
    }
  }
  child.kill(signal);
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
    let killEscalationId: ReturnType<typeof setTimeout> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

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
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      killProcessGroup(child, "SIGTERM");
      if (killEscalationId) return;
      killEscalationId = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killProcessGroup(child, "SIGKILL");
        }
      }, KILL_ESCALATION_MS);
      killEscalationId.unref();
    };
    function handleAbort(): void {
      aborted = true;
      terminate();
    }
    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (exceededOutputBound) return;
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

    child.stdout?.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
    child.on("error", (error) => {
      if (aborted || signal?.aborted) {
        rejectOnce(createCodexRequestCanceledError());
        return;
      }
      if (timedOut) {
        rejectOnce(new Error(`Git command timed out after ${String(timeoutMs)}ms`));
        return;
      }
      rejectOnce(error);
    });
    child.on("close", (code) => {
      if (settled) return;
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
    });
  });
}
