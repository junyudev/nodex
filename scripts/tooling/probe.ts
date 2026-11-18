import { runCommand, type Command } from "./process";

// Individual fixture commands normally take seconds. Leave headroom for busy CI runners.
const commandTimeoutMs = 120_000;
const outputLimit = 16 * 1024 * 1024;
const tailLimit = 8 * 1024;

/** Print completed probes even when a contract assertion fails after its command exits. */
export async function measureToolingProbe<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    process.stdout.write(
      `[tooling] ${name} (${((performance.now() - started) / 1000).toFixed(2)}s)\n`,
    );
  }
}

/** Drain both pipes, close stdin, and cancel the entire command tree when its bound expires. */
export async function runToolingProbe(
  name: string,
  options: Pick<Command, "command" | "args" | "cwd" | "env"> & {
    readonly timeoutMs?: number;
    readonly streamOutput?: boolean;
  },
): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error(`Invalid probe timeout: ${timeoutMs}`);
  return measureToolingProbe(name, async () => {
    const controller = new AbortController();
    let timedOut = false;
    let overflow = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const capture = (stream: "stdout" | "stderr", chunk: string) => {
      // Keep draining after the cap so cleanup cannot block on a full pipe.
      if ((stream === "stdout" ? stdout.length : stderr.length) + chunk.length > outputLimit) {
        overflow = true;
        controller.abort();
      }
      if (stream === "stdout") stdout = (stdout + chunk).slice(-outputLimit);
      else stderr = (stderr + chunk).slice(-outputLimit);
      if (options.streamOutput) process[stream].write(chunk);
    };
    const failure = (reason: string, cause?: unknown) =>
      new Error(
        [
          `${name}: ${reason}`,
          `Command: ${options.command} ${options.args.join(" ")}`,
          `Working directory: ${options.cwd ?? process.cwd()}`,
          stdout && `stdout (tail):\n${stdout.slice(-tailLimit)}`,
          stderr && `stderr (tail):\n${stderr.slice(-tailLimit)}`,
        ]
          .filter(Boolean)
          .join("\n"),
        { cause },
      );
    try {
      const result = await runCommand({
        ...options,
        signal: controller.signal,
        onStdout: (chunk) => capture("stdout", chunk),
        onStderr: (chunk) => capture("stderr", chunk),
      });
      if (timedOut) throw new Error("Process tree stopped after timeout.");
      if (overflow) throw new Error(`Probe output exceeded ${outputLimit} characters per stream.`);
      if (result.signal) throw new Error(`Terminated by ${result.signal}.`);
      return { status: result.exitCode, stdout, stderr };
    } catch (error) {
      // Keep attribution and output if process-tree cleanup itself fails.
      throw failure(
        timedOut ? `timed out after ${timeoutMs}ms.` : `probe failed: ${String(error)}`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  });
}
