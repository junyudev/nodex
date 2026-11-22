/**
 * One reading of the operating system's process table, and the grouping Nodex reports from it.
 * Pure apart from `readProcessTable`, which the process telemetry worker runs off Main.
 */

export interface ProcessTreeEntry {
  readonly pid: number;
  readonly parentPid: number;
}

export interface ProcessRow extends ProcessTreeEntry {
  /** Accumulated user and system CPU time. */
  readonly cpuSeconds: number | null;
  /** The platform's own recent CPU share, used until a baseline exists (Unix only). */
  readonly cpuPercent: number | null;
  readonly rssKb: number | null;
}

export interface ProcessTable {
  readonly sampledAtMs: number;
  readonly rows: ReadonlyMap<number, ProcessRow>;
}

export interface ProcessRoot {
  readonly pid: number;
  /** Count the root process itself. */
  readonly self: boolean;
  /** Count everything below the root. */
  readonly descendants: boolean;
}

export interface ProcessGroupRequest {
  readonly key: string;
  readonly roots: readonly ProcessRoot[];
}

export interface ProcessGroupReading {
  readonly key: string;
  readonly processes: number;
  /** CPU share over the interval since the previous reading of the same baseline. */
  readonly cpuPercent: number | null;
  readonly rssKb: number | null;
}

/** CPU time per process at one reading, so the next reading can report what happened between. */
export interface CpuBaseline {
  readonly sampledAtMs: number;
  readonly cpuSeconds: ReadonlyMap<number, number>;
}

const isPositivePid = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** `[[dd-]hh:]mm:ss[.ss]`, as `ps` prints elapsed and CPU times. */
export function parseClockSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf("-");
  const days = separator >= 0 ? Number(trimmed.slice(0, separator)) : 0;
  const parts = (separator >= 0 ? trimmed.slice(separator + 1) : trimmed).split(":").map(Number);
  if (!Number.isInteger(days) || parts.length < 2 || parts.length > 3) return null;
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, ...parts];
  return days * 86_400 + hours! * 3_600 + minutes! * 60 + seconds!;
}

/** `pid ppid` per line. */
export function parseUnixProcessTreeOutput(output: string): ProcessTreeEntry[] {
  const entries: ProcessTreeEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (isPositivePid(pid)) entries.push({ pid, parentPid: Number(match[2]) });
  }
  return entries;
}

/** `pid ppid %cpu time rss` per line, as requested by `readProcessTable`. */
export function parseUnixProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!isPositivePid(pid)) continue;
    const cpuPercent = Number(match[3]);
    rows.push({
      pid,
      parentPid: Number(match[2]),
      cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
      cpuSeconds: parseClockSeconds(match[4]!),
      rssKb: Number(match[5]),
    });
  }
  return rows;
}

interface WindowsProcessJsonRow {
  readonly ProcessId?: unknown;
  readonly ParentProcessId?: unknown;
  readonly WorkingSetSize?: unknown;
  readonly KernelModeTime?: unknown;
  readonly UserModeTime?: unknown;
}

/** `Win32_Process` rows as JSON; CPU times are in 100 ns units. */
export function parseWindowsProcessTable(output: string): ProcessRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch {
    return [];
  }
  const rows: ProcessRow[] = [];
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!row || typeof row !== "object") continue;
    const data = row as WindowsProcessJsonRow;
    const pid = Number(data.ProcessId);
    const parentPid = Number(data.ParentProcessId);
    if (!isPositivePid(pid) || !Number.isFinite(parentPid)) continue;
    const kernel = Number(data.KernelModeTime);
    const user = Number(data.UserModeTime);
    const workingSet = Number(data.WorkingSetSize);
    rows.push({
      pid,
      parentPid,
      cpuPercent: null,
      cpuSeconds:
        Number.isFinite(kernel) && Number.isFinite(user) ? (kernel + user) / 10_000_000 : null,
      rssKb: Number.isFinite(workingSet) ? Math.floor(workingSet / 1024) : null,
    });
  }
  return rows;
}

export function collectDescendantPids(
  entries: readonly ProcessTreeEntry[],
  roots: readonly { readonly pid: number; readonly includeRoot?: boolean }[],
): number[] {
  const children = childrenByParent(entries);
  const known = new Set(entries.map((entry) => entry.pid));
  const queue: number[] = [];
  for (const root of roots) {
    if (root.includeRoot && known.has(root.pid)) queue.push(root.pid);
    else queue.push(...(children.get(root.pid) ?? []));
  }
  const descendants = new Set<number>();
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index]!;
    if (descendants.has(pid)) continue;
    descendants.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return [...descendants];
}

function childrenByParent(entries: Iterable<ProcessTreeEntry>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    if (entry.parentPid === entry.pid) continue;
    const siblings = children.get(entry.parentPid);
    if (siblings) siblings.push(entry.pid);
    else children.set(entry.parentPid, [entry.pid]);
  }
  return children;
}

export const cpuBaseline = (table: ProcessTable): CpuBaseline => ({
  sampledAtMs: table.sampledAtMs,
  cpuSeconds: new Map(
    [...table.rows.values()].flatMap((row) =>
      row.cpuSeconds === null ? [] : ([[row.pid, row.cpuSeconds]] as const),
    ),
  ),
});

/**
 * A process's CPU share since the baseline. A process the baseline did not see started during the
 * interval, so all of its CPU time belongs to it; without a baseline the platform's own share is
 * the best available reading.
 */
export function cpuPercentSince(row: ProcessRow, at: number, baseline: CpuBaseline | null) {
  const elapsedSeconds = baseline ? (at - baseline.sampledAtMs) / 1_000 : 0;
  if (!baseline || elapsedSeconds <= 0 || row.cpuSeconds === null) return row.cpuPercent;
  const before = baseline.cpuSeconds.get(row.pid) ?? 0;
  // A reused pid can report less CPU time than the process it replaced.
  const used = row.cpuSeconds >= before ? row.cpuSeconds - before : row.cpuSeconds;
  return (used / elapsedSeconds) * 100;
}

/**
 * Groups processes by root. Each process counts once, in the first group whose roots reach it;
 * walking a root's descendants passes through processes an earlier group claimed.
 */
export function readProcessGroups(
  table: ProcessTable,
  groups: readonly ProcessGroupRequest[],
  baseline: CpuBaseline | null,
): ProcessGroupReading[] {
  const children = childrenByParent(table.rows.values());
  const claimed = new Set<number>();
  return groups.map((group) => {
    let processes = 0;
    let cpuPercent: number | null = null;
    let rssKb: number | null = null;
    const claim = (pid: number) => {
      const row = table.rows.get(pid);
      if (!row || claimed.has(pid)) return;
      claimed.add(pid);
      processes += 1;
      const cpu = cpuPercentSince(row, table.sampledAtMs, baseline);
      if (cpu !== null) cpuPercent = (cpuPercent ?? 0) + cpu;
      if (row.rssKb !== null) rssKb = (rssKb ?? 0) + row.rssKb;
    };
    for (const root of group.roots) {
      if (!table.rows.has(root.pid)) continue;
      if (root.self) claim(root.pid);
      if (!root.descendants) continue;
      const queue = [...(children.get(root.pid) ?? [])];
      const visited = new Set<number>([root.pid]);
      for (let index = 0; index < queue.length; index += 1) {
        const pid = queue[index]!;
        if (visited.has(pid)) continue;
        visited.add(pid);
        claim(pid);
        queue.push(...(children.get(pid) ?? []));
      }
    }
    return {
      key: group.key,
      processes,
      cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10,
      rssKb,
    };
  });
}
