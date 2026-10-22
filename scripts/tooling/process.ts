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
  /** Only for installers that create root-owned descendants through sudo. */
  readonly privilegedCancellation?: boolean;
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

function liveProcessGroups(groups: readonly number[]): readonly number[] {
  const output = execFileSync("ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    timeout: 1_000,
    killSignal: "SIGKILL",
  });
  const live = new Set(
    output
      .trim()
      .split("\n")
      .flatMap((line) => {
        const [group, state] = line.trim().split(/\s+/u);
        // Zombies cannot hold package-manager locks and must be reaped by their parent.
        return state?.startsWith("Z") ? [] : [Number(group)];
      }),
  );
  return groups.filter((group) => live.has(group));
}

async function waitForProcessGroups(groups: readonly number[]): Promise<boolean> {
  const deadline = performance.now() + 2_000;
  while (true) {
    if (liveProcessGroups(groups).length === 0) return true;
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Cancellation succeeds only after every captured group has stopped. */
async function stopProcessGroups(rootPid: number, privileged: boolean): Promise<void> {
  const failures: unknown[] = [];
  let groups: readonly number[] = [rootPid];
  let completeSnapshot = false;
  try {
    groups = ownedProcessGroups(rootPid);
    completeSnapshot = true;
  } catch (error) {
    failures.push(error);
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const group of groups) {
      try {
        if (privileged) {
          // A successful unprivileged kill may still leave root-owned group members alive.
          execFileSync("sudo", ["-n", "/bin/kill", "-s", signal, "--", String(-group)], {
            stdio: "ignore",
            timeout: 1_000,
            killSignal: "SIGKILL",
          });
        } else {
          process.kill(-group, signal);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if ((await waitForProcessGroups(groups)) && completeSnapshot) return;
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(
    failures,
    `Could not stop command process groups ${groups.join(", ")}: ${failures.map(String).join("; ")}`,
  );
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
    return await new Promise((resolve, reject) => {
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
      let cancellation: Promise<void> | undefined;
      const abort = () => {
        if (!child.pid || cancellation) return;
        cancellation = (async () => {
          if (process.platform !== "win32") {
            await stopProcessGroups(child.pid!, options.privilegedCancellation ?? false);
            return;
          }
          // Windows has no POSIX process groups; taskkill owns descendant traversal.
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            timeout: 2_000,
            killSignal: "SIGKILL",
          });
        })();
        // A cleanup failure must reject the command, never escape an event/timer callback.
        void cancellation.catch((error: unknown) => {
          observation?.();
          options.signal?.removeEventListener("abort", abort);
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          reject(error);
        });
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
        observation?.();
        options.signal?.removeEventListener("abort", abort);
        void Promise.resolve(cancellation).then(() => {
          resolve({
            exitCode: options.signal?.aborted ? 130 : (code ?? 1),
            signal,
            durationMs: performance.now() - started,
            ...(samples ? { resources: { peakTreeRssBytes, samples, intervalMs: 1_000 } } : {}),
          });
        }, reject);
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
