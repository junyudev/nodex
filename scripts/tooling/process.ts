import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";

export interface Command {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly logFile?: string;
  readonly onStdout?: (chunk: string) => void;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
}

/** Own the spawned process group so cancellation also reaches native/test grandchildren. */
export async function runCommand(options: Command): Promise<CommandResult> {
  const started = performance.now();
  if (options.signal?.aborted) {
    return { exitCode: 130, signal: "SIGINT", durationMs: 0 };
  }
  if (options.logFile) mkdirSync(path.dirname(options.logFile), { recursive: true });
  const log = options.logFile ? openSync(options.logFile, "w") : undefined;
  try {
    return await new Promise((resolve) => {
      const child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      };
      const abort = () => {
        kill("SIGTERM");
        escalation = setTimeout(() => kill("SIGKILL"), 2_000);
        escalation.unref();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        if (log !== undefined) writeSync(log, chunk);
        if (options.onStdout) options.onStdout(chunk);
        else process.stdout.write(chunk);
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        if (log !== undefined) writeSync(log, chunk);
        process.stderr.write(chunk);
      });
      child.once("error", (error) => process.stderr.write(error.message + "\n"));
      child.once("close", (code, signal) => {
        clearTimeout(escalation);
        options.signal?.removeEventListener("abort", abort);
        resolve({
          exitCode: options.signal?.aborted ? 130 : (code ?? 1),
          signal,
          durationMs: performance.now() - started,
        });
      });
    });
  } finally {
    if (log !== undefined) closeSync(log);
  }
}

/** Install only at a CLI boundary, never when a module is imported by tests. */
export async function withCommandSignal(
  run: (signal: AbortSignal) => Promise<number>,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    process.exitCode = await run(controller.signal);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
