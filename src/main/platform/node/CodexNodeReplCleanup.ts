/* @effect-diagnostics asyncFunction:off -- Filesystem records and process ancestry are checked at the Node boundary; the application runtime owns timeout and cancellation. */
import * as Effect from "effect/Effect";
import type { WindowsDesktopToolsService, WindowsProcessIdentity } from "./WindowsDesktopTools";
import { windowsImageEquals } from "../../browser-use/browser-use-peer-authorizer";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

interface ExecutionRecord {
  version: 1;
  execId: string;
  sessionId: string;
  turnId: string;
  nodeReplPid: number;
  kernelPid: number;
  startedAtMs: number;
}
interface ChildProcessIdentity {
  readonly pid: number;
  readonly depth: number;
}
export interface NodeReplCleanupCounts {
  failedCount: number;
  killedCount: number;
  scannedCount: number;
  staleCount: number;
}
export interface NodeReplCleanupDependencies {
  readonly listChildProcesses?: (pid: number) => Promise<readonly ChildProcessIdentity[]>;
  readonly kill?: (pid: number, signal: "SIGKILL") => void;
  readonly removeRecordFile?: typeof rm;
  readonly windows?: {
    readonly runNative: typeof Effect.runPromise;
    readonly native: Pick<
      WindowsDesktopToolsService,
      "processIdentity" | "descendants" | "terminateSubtree"
    >;
    readonly replPath: string;
    readonly nodePath: string;
    readonly isOwnedRepl: (identity: WindowsProcessIdentity) => Effect.Effect<boolean>;
  };
}
const empty = (): NodeReplCleanupCounts => ({
  failedCount: 0,
  killedCount: 0,
  scannedCount: 0,
  staleCount: 0,
});
const exec = promisify(execFile);
const errno = (error: unknown, code: string) =>
  error !== null && typeof error === "object" && "code" in error && error.code === code;

export function descendantProcessIdentities(
  root: number,
  rows: readonly { readonly pid: number; readonly parentPid: number }[],
): readonly ChildProcessIdentity[] {
  const children = new Map<number, number[]>();
  for (const { pid, parentPid } of rows)
    children.set(parentPid, [...(children.get(parentPid) ?? []), pid]);
  const result: ChildProcessIdentity[] = [];
  const pending = [{ pid: root, depth: 0 }];
  const seen = new Set([root]);
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index]!;
    for (const pid of children.get(current.pid) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const child = { pid, depth: current.depth + 1 };
      result.push(child);
      pending.push(child);
    }
  }
  return result;
}

/** Recheck selected processes after enumeration so exited or reparented children are excluded. */
export async function listNodeReplChildProcesses(
  root: number,
  run: (args: readonly string[]) => Promise<string> = async (args) => {
    const { stdout } = await exec(process.platform === "darwin" ? "/bin/ps" : "ps", [...args], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  },
  options: {
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<readonly ChildProcessIdentity[]> {
  if ((options.platform ?? process.platform) === "win32")
    throw new Error("Windows REPL cleanup requires the native process provider");
  const initial = await run(["-ax", "-o", "pid=,ppid="]);
  const rows = initial.split("\n").flatMap((line) => {
    const match = /^(\d+)\s+(\d+)$/.exec(line.trim());
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]) }] : [];
  });
  const selected = descendantProcessIdentities(root, rows)
    .map(({ pid }) => pid)
    .sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let index = 0; index < selected.length; index += 200)
    chunks.push(selected.slice(index, index + 200));
  const snapshots = await Promise.all(
    chunks.map((pids) =>
      run(["-p", pids.join(","), "-o", "pid=,ppid=,%cpu=,rss=,lstart=,command="]),
    ),
  );
  const current = snapshots.flatMap((snapshot) =>
    snapshot.split("\n").flatMap((line) => {
      const match =
        /^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
          line.trim(),
        );
      return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]) }] : [];
    }),
  );
  return descendantProcessIdentities(root, current);
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
async function readRecord(path: string): Promise<ExecutionRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object") return null;
    const record = value as Partial<ExecutionRecord>;
    if (
      record.version !== 1 ||
      !nonempty(record.execId) ||
      !nonempty(record.sessionId) ||
      !nonempty(record.turnId) ||
      !positive(record.nodeReplPid) ||
      !positive(record.kernelPid) ||
      typeof record.startedAtMs !== "number" ||
      !Number.isInteger(record.startedAtMs) ||
      record.startedAtMs < 0
    )
      return null;
    return record as ExecutionRecord;
  } catch {
    return null;
  }
}
function kill(
  pid: number,
  dependencies: NodeReplCleanupDependencies,
): "killed" | "missing" | "failed" {
  try {
    (dependencies.kill ?? process.kill)(pid, "SIGKILL");
    return "killed";
  } catch (error) {
    return errno(error, "ESRCH") ? "missing" : "failed";
  }
}
async function remove(path: string, dependencies: NodeReplCleanupDependencies): Promise<boolean> {
  try {
    await (dependencies.removeRecordFile ?? rm)(path, { force: true });
    return true;
  } catch {
    return false;
  }
}
async function killWindowsRecord(
  record: ExecutionRecord,
  binding: NonNullable<NodeReplCleanupDependencies["windows"]>,
  signal?: AbortSignal,
): Promise<"killed" | "stale" | "failed"> {
  try {
    return await binding.runNative(
      Effect.gen(function* () {
        const repl = yield* binding.native.processIdentity(record.nodeReplPid);
        if (
          !windowsImageEquals(repl.imagePath, binding.replPath) ||
          !(yield* binding.isOwnedRepl(repl))
        )
          return "failed" as const;
        const tree = yield* binding.native.descendants(repl);
        const kernel = tree.find(
          (identity) =>
            identity.pid === record.kernelPid &&
            windowsImageEquals(identity.imagePath, binding.nodePath),
        );
        if (!kernel) return "stale" as const;
        const terminated = yield* binding.native.terminateSubtree(kernel);
        return terminated.includes(kernel.pid) ? ("killed" as const) : ("failed" as const);
      }),
      { signal },
    );
  } catch {
    signal?.throwIfAborted();
    return "failed";
  }
}

async function killRecord(
  record: ExecutionRecord,
  dependencies: NodeReplCleanupDependencies,
  signal?: AbortSignal,
): Promise<"killed" | "stale" | "failed"> {
  if (dependencies.windows) return killWindowsRecord(record, dependencies.windows, signal);
  const list = dependencies.listChildProcesses ?? listNodeReplChildProcesses;
  let ownerChildren: readonly ChildProcessIdentity[];
  try {
    ownerChildren = await list(record.nodeReplPid);
  } catch {
    signal?.throwIfAborted();
    return "failed";
  }
  signal?.throwIfAborted();
  if (!ownerChildren.some(({ pid }) => pid === record.kernelPid)) return "stale";
  let descendants: readonly ChildProcessIdentity[];
  try {
    descendants = await list(record.kernelPid);
  } catch {
    signal?.throwIfAborted();
    kill(record.kernelPid, dependencies);
    return "failed";
  }
  let failed = false;
  const pids = [...descendants].sort((a, b) => b.depth - a.depth).map(({ pid }) => pid);
  for (const pid of new Set([...pids, record.kernelPid])) {
    signal?.throwIfAborted();
    if (kill(pid, dependencies) === "failed") failed = true;
  }
  return failed ? "failed" : "killed";
}

/** Native boundary: prove the recorded kernel still belongs to its REPL before killing it. */
export async function cleanupNodeReplExecutions(input: {
  readonly codexHome: string;
  readonly platform?: NodeJS.Platform;
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly dependencies?: NodeReplCleanupDependencies;
}): Promise<NodeReplCleanupCounts> {
  const { codexHome, sessionId, turnId, signal, dependencies = {} } = input;
  signal?.throwIfAborted();
  if ((input.platform ?? process.platform) === "win32" && !dependencies.windows)
    throw new Error("Windows REPL cleanup requires the native process provider");
  const directory = join(codexHome, "node_repl", "active_execs");
  let paths: string[];
  try {
    paths = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(directory, entry.name));
  } catch (error) {
    if (errno(error, "ENOENT")) return empty();
    throw error;
  }
  const counts = await Promise.all(
    paths.map(async (path): Promise<NodeReplCleanupCounts> => {
      signal?.throwIfAborted();
      const record = await readRecord(path);
      signal?.throwIfAborted();
      if (!record) return { ...empty(), scannedCount: 1 };
      if (record.sessionId !== sessionId || record.turnId !== turnId)
        return { ...empty(), scannedCount: 1 };
      const outcome = await killRecord(record, dependencies, signal);
      if (outcome === "failed") return { ...empty(), failedCount: 1, scannedCount: 1 };
      return {
        ...empty(),
        failedCount: Number(!(await remove(path, dependencies))),
        scannedCount: 1,
        killedCount: Number(outcome === "killed"),
        staleCount: Number(outcome === "stale"),
      };
    }),
  );
  return counts.reduce(
    (sum, count) => ({
      failedCount: sum.failedCount + count.failedCount,
      killedCount: sum.killedCount + count.killedCount,
      scannedCount: sum.scannedCount + count.scannedCount,
      staleCount: sum.staleCount + count.staleCount,
    }),
    empty(),
  );
}
