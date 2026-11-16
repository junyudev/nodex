import { execFileAsync } from "./platform/node/child-stdio-errors";

const UNIX_TIMEOUT_MS = 2_000;
const WINDOWS_TIMEOUT_MS = 5_000;
const UNIX_MAX_BUFFER = 1024 * 1024;
const WINDOWS_MAX_BUFFER = 8 * 1024 * 1024;
const PROCESS_CHUNK_SIZE = 200;

interface ProcessRoot {
  pid: number;
  includeRoot?: boolean;
}

export interface ProcessTreeEntry {
  pid: number;
  parentPid: number;
}

export interface ProcessMetricSample extends ProcessTreeEntry {
  command: string;
  ageSeconds: number | null;
  cpuPercent: number | null;
  rssKb: bigint | null;
}

export interface TerminalProcessMetricsSnapshot {
  cpuPercent: number | null;
  rssKb: bigint | null;
  childProcessCount: number;
  sampledAtMs: number;
}

interface WindowsProcessJsonRow {
  AgeSeconds?: unknown;
  CommandLine?: unknown;
  CpuPercent?: unknown;
  ParentProcessId?: unknown;
  ProcessId?: unknown;
  WorkingSetSize?: unknown;
}

function isPositivePid(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function normalizeProcessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: process.env.LC_ALL ?? "C",
  };
}

async function execUtf8(
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide?: boolean },
): Promise<string> {
  const result = await execFileAsync(file, [...args], {
    encoding: "utf8",
    env: normalizeProcessEnv(),
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    windowsHide: options.windowsHide,
  });
  return String(result.stdout);
}

export function parseUnixProcessTreeOutput(output: string): ProcessTreeEntry[] {
  const entries: ProcessTreeEntry[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = /^(\d+)\s+(\d+)$/.exec(trimmed);
    if (!match) continue;

    const pid = Number.parseInt(match[1]!, 10);
    const parentPid = Number.parseInt(match[2]!, 10);
    if (!isPositivePid(pid) || !Number.isFinite(parentPid)) continue;
    entries.push({ pid, parentPid });
  }
  return entries;
}

export function parseUnixProcessMetricOutput(output: string): ProcessMetricSample[] {
  const entries: ProcessMetricSample[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = /^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(trimmed);
    if (!match) continue;

    const pid = Number.parseInt(match[1]!, 10);
    const parentPid = Number.parseInt(match[2]!, 10);
    const cpuPercent = Number.parseFloat(match[3]!);
    const rssKb = Number.parseInt(match[4]!, 10);
    if (!isPositivePid(pid) || !Number.isFinite(parentPid)) continue;

    entries.push({
      pid,
      parentPid,
      command: match[6]!.trim(),
      ageSeconds: parseUnixElapsedSeconds(match[5]!),
      cpuPercent: Number.isFinite(cpuPercent) ? Math.max(0, cpuPercent) : null,
      rssKb: Number.isFinite(rssKb) ? BigInt(Math.max(0, rssKb)) : null,
    });
  }
  return entries;
}

export function parseWindowsProcessMetricOutput(output: string): ProcessMetricSample[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const entries: ProcessMetricSample[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const data = row as WindowsProcessJsonRow;
    const pid = Number(data.ProcessId);
    const parentPid = Number(data.ParentProcessId);
    if (!isPositivePid(pid) || !Number.isFinite(parentPid)) continue;

    const command = typeof data.CommandLine === "string" ? data.CommandLine.trim() : "";
    const ageSeconds = Number(data.AgeSeconds);
    const cpuPercent = Number(data.CpuPercent);
    const workingSetSize = Number(data.WorkingSetSize);

    entries.push({
      pid,
      parentPid,
      command,
      ageSeconds: Number.isFinite(ageSeconds) ? Math.max(0, Math.floor(ageSeconds)) : null,
      cpuPercent: Number.isFinite(cpuPercent) ? Math.max(0, cpuPercent) : null,
      rssKb: Number.isFinite(workingSetSize)
        ? BigInt(Math.max(0, Math.floor(workingSetSize / 1024)))
        : null,
    });
  }
  return entries;
}

export function collectDescendantPids(
  entries: readonly ProcessTreeEntry[],
  roots: readonly ProcessRoot[],
): number[] {
  const childrenByParentPid = new Map<number, number[]>();
  const knownPids = new Set<number>();
  for (const entry of entries) {
    knownPids.add(entry.pid);
    const children = childrenByParentPid.get(entry.parentPid) ?? [];
    children.push(entry.pid);
    childrenByParentPid.set(entry.parentPid, children);
  }

  const queue: number[] = [];
  for (const root of roots) {
    if (root.includeRoot && knownPids.has(root.pid)) {
      queue.push(root.pid);
      continue;
    }
    queue.push(...(childrenByParentPid.get(root.pid) ?? []));
  }

  const descendants = new Set<number>();
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index];
    if (pid === undefined || descendants.has(pid)) continue;

    descendants.add(pid);
    queue.push(...(childrenByParentPid.get(pid) ?? []));
  }

  return [...descendants];
}

export function aggregateTerminalProcessMetrics(
  samples: readonly ProcessMetricSample[],
  sampledAtMs = Date.now(),
): TerminalProcessMetricsSnapshot {
  let cpuPercent: number | null = null;
  let rssKb: bigint | null = null;

  for (const sample of samples) {
    if (sample.cpuPercent !== null) {
      cpuPercent = (cpuPercent ?? 0) + sample.cpuPercent;
    }
    if (sample.rssKb !== null) {
      rssKb = (rssKb ?? 0n) + sample.rssKb;
    }
  }

  return {
    cpuPercent,
    rssKb,
    childProcessCount: samples.length,
    sampledAtMs,
  };
}

export async function readTerminalProcessMetricsByRootPid(
  rootPids: readonly number[],
  platform: NodeJS.Platform = process.platform,
): Promise<Map<number, TerminalProcessMetricsSnapshot>> {
  const validRootPids = [...new Set(rootPids.filter(isPositivePid))];
  const sampledAtMs = Date.now();
  const metricsByRootPid = new Map<number, TerminalProcessMetricsSnapshot>();
  for (const rootPid of validRootPids) {
    metricsByRootPid.set(rootPid, aggregateTerminalProcessMetrics([], sampledAtMs));
  }
  if (validRootPids.length === 0) return metricsByRootPid;

  const processTree =
    platform === "win32"
      ? await readWindowsProcessTreeEntries()
      : await readUnixProcessTreeEntries();
  const descendantPidsByRootPid = new Map<number, number[]>();
  const allDescendantPids = new Set<number>();

  for (const rootPid of validRootPids) {
    const descendantPids = collectDescendantPids(processTree, [
      { pid: rootPid, includeRoot: false },
    ]).sort((left, right) => left - right);
    descendantPidsByRootPid.set(rootPid, descendantPids);
    for (const pid of descendantPids) allDescendantPids.add(pid);
  }

  if (allDescendantPids.size === 0) return metricsByRootPid;

  const samples =
    platform === "win32"
      ? await readWindowsProcessMetricSamples(
          [...allDescendantPids].sort((left, right) => left - right),
        )
      : await readUnixProcessMetricSamples(
          [...allDescendantPids].sort((left, right) => left - right),
        );
  const sampleByPid = new Map(samples.map((sample) => [sample.pid, sample]));

  for (const [rootPid, descendantPids] of descendantPidsByRootPid) {
    metricsByRootPid.set(
      rootPid,
      aggregateTerminalProcessMetrics(
        descendantPids.flatMap((pid) => sampleByPid.get(pid) ?? []),
        sampledAtMs,
      ),
    );
  }
  return metricsByRootPid;
}

function parseUnixElapsedSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let days = 0;
  let time = trimmed;
  const daySeparatorIndex = trimmed.indexOf("-");
  if (daySeparatorIndex >= 0) {
    days = Number.parseInt(trimmed.slice(0, daySeparatorIndex), 10);
    time = trimmed.slice(daySeparatorIndex + 1);
    if (!Number.isFinite(days)) return null;
  }

  const parts = time.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  const [hoursOrMinutes, minutesOrSeconds, maybeSeconds] = parts;
  const hours = maybeSeconds === undefined ? 0 : hoursOrMinutes!;
  const minutes = maybeSeconds === undefined ? hoursOrMinutes! : minutesOrSeconds!;
  const seconds = maybeSeconds === undefined ? minutesOrSeconds! : maybeSeconds;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

async function readUnixProcessTreeEntries(): Promise<ProcessTreeEntry[]> {
  const treeOutput = await execUtf8("ps", ["-ax", "-o", "pid=,ppid="], {
    timeout: UNIX_TIMEOUT_MS,
    maxBuffer: UNIX_MAX_BUFFER,
  });
  return parseUnixProcessTreeOutput(treeOutput);
}

async function readUnixProcessMetricSamples(
  pids: readonly number[],
): Promise<ProcessMetricSample[]> {
  if (pids.length === 0) return [];

  const chunks = chunk(pids, PROCESS_CHUNK_SIZE);
  const outputs = await Promise.all(
    chunks.map((pids) =>
      execUtf8("ps", ["-p", pids.join(","), "-o", "pid=,ppid=,%cpu=,rss=,etime=,command="], {
        timeout: UNIX_TIMEOUT_MS,
        maxBuffer: UNIX_MAX_BUFFER,
      }),
    ),
  );
  return outputs.flatMap(parseUnixProcessMetricOutput);
}

async function readWindowsProcessTreeEntries(): Promise<ProcessTreeEntry[]> {
  const treeOutput = await execUtf8(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop';",
        "Get-CimInstance Win32_Process",
        "| Select-Object ProcessId,ParentProcessId",
        "| ConvertTo-Json -Depth 2",
      ].join(" "),
    ],
    {
      timeout: WINDOWS_TIMEOUT_MS,
      maxBuffer: WINDOWS_MAX_BUFFER,
      windowsHide: true,
    },
  );
  return parseWindowsProcessMetricOutput(treeOutput);
}

async function readWindowsProcessMetricSamples(
  pids: readonly number[],
): Promise<ProcessMetricSample[]> {
  if (pids.length === 0) return [];

  const chunks = chunk(pids, PROCESS_CHUNK_SIZE);
  const outputs = await Promise.all(
    chunks.map((pids) =>
      execUtf8(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", buildWindowsMetricCommand(pids)],
        {
          timeout: WINDOWS_TIMEOUT_MS,
          maxBuffer: WINDOWS_MAX_BUFFER,
          windowsHide: true,
        },
      ),
    ),
  );
  return outputs.flatMap(parseWindowsProcessMetricOutput);
}

function buildWindowsMetricCommand(pids: readonly number[]): string {
  const processFilter = pids.map((pid) => `ProcessId = ${pid}`).join(" OR ");
  return [
    "$ErrorActionPreference = 'Stop';",
    "$cpuByPid = @{};",
    "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $cpuByPid[[int]$_.IDProcess] = [double]$_.PercentProcessorTime };",
    `Get-CimInstance Win32_Process -Filter "${processFilter}"`,
    "| Select-Object ProcessId,ParentProcessId,CommandLine,WorkingSetSize,@{Name='CpuPercent';Expression={$cpuByPid[[int]$_.ProcessId]}},@{Name='AgeSeconds';Expression={[int]((Get-Date) - $_.CreationDate).TotalSeconds}}",
    "| ConvertTo-Json -Depth 2",
  ].join(" ");
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
