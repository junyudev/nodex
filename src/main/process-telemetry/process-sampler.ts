import { execFileAsync } from "../platform/node/child-stdio-errors";
import {
  cpuBaseline,
  parseUnixProcessTable,
  parseWindowsProcessTable,
  readProcessGroups,
  type CpuBaseline,
  type ProcessGroupReading,
  type ProcessGroupRequest,
  type ProcessRow,
  type ProcessTable,
} from "./process-table";

const UNIX_TIMEOUT_MS = 2_000;
const WINDOWS_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** One spawn reads every process: identity, CPU time and resident memory, without commands. */
export async function readProcessTable(platform: NodeJS.Platform): Promise<ProcessRow[]> {
  const env = { ...process.env, LC_ALL: process.env.LC_ALL ?? "C" };
  if (platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress",
      ],
      {
        encoding: "utf8",
        env,
        maxBuffer: MAX_BUFFER,
        timeout: WINDOWS_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return parseWindowsProcessTable(stdout);
  }
  const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,ppid=,%cpu=,time=,rss="], {
    encoding: "utf8",
    env,
    maxBuffer: MAX_BUFFER,
    timeout: UNIX_TIMEOUT_MS,
  });
  return parseUnixProcessTable(stdout);
}

export interface ProcessSampleRequest {
  /** Names whose interval CPU share this reading reports, and which it then advances. */
  readonly baseline: string;
  /** A table read this recently answers the request. */
  readonly maxAgeMs: number;
  readonly groups: readonly ProcessGroupRequest[];
}

export interface ProcessSample {
  readonly sampledAtMs: number;
  readonly groups: readonly ProcessGroupReading[];
}

/**
 * Every consumer shares one recent table, and concurrent requests share one read. Each baseline
 * keeps its own CPU reference, so a once-a-minute sampler and a once-a-second view each see CPU
 * over their own interval.
 */
export function createProcessSampler(options: {
  readonly read: () => Promise<readonly ProcessRow[]>;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  /** Per baseline: the table it last read, the reference that reading used, and that table. */
  const baselines = new Map<
    string,
    {
      readonly table: ProcessTable;
      readonly reference: CpuBaseline | null;
      readonly next: CpuBaseline;
    }
  >();
  let latest: ProcessTable | null = null;
  let reading: Promise<ProcessTable> | null = null;

  const table = (maxAgeMs: number): Promise<ProcessTable> => {
    if (latest && now() - latest.sampledAtMs <= maxAgeMs) return Promise.resolve(latest);
    reading ??= options
      .read()
      .then((rows) => {
        latest = { sampledAtMs: now(), rows: new Map(rows.map((row) => [row.pid, row])) };
        return latest;
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  };

  return {
    async sample(request: ProcessSampleRequest): Promise<ProcessSample> {
      const current = await table(request.maxAgeMs);
      const state = baselines.get(request.baseline);
      // Requests answered by the same table report the same interval.
      const reference = state?.table === current ? state.reference : (state?.next ?? null);
      if (state?.table !== current)
        baselines.set(request.baseline, {
          table: current,
          reference,
          next: cpuBaseline(current),
        });
      return {
        sampledAtMs: current.sampledAtMs,
        groups: readProcessGroups(current, request.groups, reference),
      };
    },
  };
}
