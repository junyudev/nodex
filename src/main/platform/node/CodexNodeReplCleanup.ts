/* oxlint-disable effecttsgo/async-function -- Filesystem records and process ancestry are checked at the Node boundary; the application runtime owns timeout and cancellation. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
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

export interface NodeReplNativeProcessProvider {
  listProcesses?: (options: {
    includeCommandLine: true;
    rootPid: number;
  }) =>
    | Promise<readonly { pid: number; parentPid: number }[]>
    | readonly { pid: number; parentPid: number }[];
}

/** The optional native process provider is loaded lazily and only cached after installation. */
export function createNodeReplWindowsProcessProviderLoader(options: {
  readonly resourcesPath?: string;
  readonly exists?: (path: string) => boolean;
  readonly load?: (path: string) => unknown;
}): () => NodeReplNativeProcessProvider | null {
  let installed: NodeReplNativeProcessProvider | null = null;
  return () => {
    if (installed) return installed;
    if (!options.resourcesPath) return null;
    const path = join(options.resourcesPath, "native", "windows-account.node");
    if (!(options.exists ?? existsSync)(path)) return null;
    const addon: unknown = (options.load ?? createRequire(import.meta.url))(path);
    if (addon === null || typeof addon !== "object")
      throw new Error("Invalid native process provider");
    installed = addon as NodeReplNativeProcessProvider;
    return installed;
  };
}

const loadWindowsProvider = createNodeReplWindowsProcessProviderLoader({
  resourcesPath: process.resourcesPath,
});

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
    readonly loadWindowsProvider?: () => NodeReplNativeProcessProvider | null;
  } = {},
): Promise<readonly ChildProcessIdentity[]> {
  if ((options.platform ?? process.platform) === "win32") {
    const rows =
      (await (options.loadWindowsProvider ?? loadWindowsProvider)()?.listProcesses?.({
        includeCommandLine: true,
        rootPid: root,
      })) ?? [];
    return descendantProcessIdentities(root, rows);
  }
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
async function killRecord(
  record: ExecutionRecord,
  dependencies: NodeReplCleanupDependencies,
  signal?: AbortSignal,
): Promise<"killed" | "stale" | "failed"> {
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
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly dependencies?: NodeReplCleanupDependencies;
}): Promise<NodeReplCleanupCounts> {
  const { codexHome, sessionId, turnId, signal, dependencies = {} } = input;
  signal?.throwIfAborted();
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
      if (!record)
        return {
          ...empty(),
          failedCount: Number(!(await remove(path, dependencies))),
          staleCount: 1,
        };
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
