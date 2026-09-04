import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
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
  readonly measureResources?: boolean;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly resources?: {
    readonly peakTreeRssBytes: number;
    readonly samples: number;
    readonly intervalMs: number;
  };
}

const processTableArguments = ["-axo", "pid=,ppid=,pgid=,rss="];

function parseProcessTable(output: string): readonly (readonly number[])[] {
  return output
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number));
}

function descendantPids(
  rootPid: number,
  rows: readonly (readonly number[])[],
): ReadonlySet<number> {
  const owned = new Set([rootPid]);
  let added = true;
  while (added) {
    added = false;
    for (const [pid, parent] of rows) {
      if (!owned.has(parent) || owned.has(pid)) continue;
      owned.add(pid);
      added = true;
    }
  }
  return owned;
}

function ownedProcessGroups(rootPid: number): readonly number[] {
  // Bound the pre-cancellation snapshot so an overloaded system cannot stall cancellation.
  const rows = parseProcessTable(
    execFileSync("ps", processTableArguments, {
      encoding: "utf8",
      timeout: 1_000,
      killSignal: "SIGKILL",
    }),
  );
  const owned = descendantPids(rootPid, rows);
  return [
    ...new Set([
      rootPid,
      ...rows
        .filter(([pid, , group]) => owned.has(pid) && owned.has(group))
        .map(([, , group]) => group),
    ]),
  ];
}

/** Advisory sampling must never block command output or overlap its own snapshots. */
function observeProcessTree(rootPid: number, onSample: (bytes: number) => void): () => void {
  let pending: ChildProcess | undefined;
  let stopped = false;
  const timer = setInterval(() => {
    if (pending) return;
    pending = execFile(
      "ps",
      processTableArguments,
      { encoding: "utf8", timeout: 1_000, killSignal: "SIGKILL" },
      (error, output) => {
        pending = undefined;
        if (error || stopped) return;
        const rows = parseProcessTable(output);
        const owned = descendantPids(rootPid, rows);
        const rss = rows.reduce((sum, [pid, , , memory]) => sum + (owned.has(pid) ? memory : 0), 0);
        onSample(rss * 1024);
      },
    );
  }, 1_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    pending?.kill("SIGKILL");
  };
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
      let peakTreeRssBytes = 0;
      let samples = 0;
      const observation =
        options.measureResources && child.pid && process.platform !== "win32"
          ? observeProcessTree(child.pid, (rss) => {
              peakTreeRssBytes = Math.max(peakTreeRssBytes, rss);
              samples += 1;
            })
          : undefined;
      let groups: readonly number[] = [];
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          // Windows has no POSIX process groups; taskkill owns descendant traversal.
          try {
            execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          } catch {
            child.kill(signal);
          }
          return;
        }
        for (const group of groups) {
          try {
            process.kill(-group, signal);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        }
      };
      const abort = () => {
        if (child.pid && process.platform !== "win32") {
          try {
            groups = ownedProcessGroups(child.pid);
          } catch {
            groups = [child.pid];
          }
        }
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
        if (options.signal?.aborted) kill("SIGKILL");
        clearTimeout(escalation);
        observation?.();
        options.signal?.removeEventListener("abort", abort);
        resolve({
          exitCode: options.signal?.aborted ? 130 : (code ?? 1),
          signal,
          durationMs: performance.now() - started,
          ...(samples ? { resources: { peakTreeRssBytes, samples, intervalMs: 1_000 } } : {}),
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
