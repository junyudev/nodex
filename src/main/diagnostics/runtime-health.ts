import type { components } from "@nodex/core-protocol";
import type { ElectronProcess, ElectronProcessKind } from "../platform/electron/ElectronProcesses";
import type { ProcessGroupReading, ProcessGroupRequest } from "../process-telemetry/process-table";

type CoreHealthMetrics = components["schemas"]["CoreHealthMetrics"];
type HealthDurationMetric = components["schemas"]["HealthDurationMetric"];

/** Where CPU and memory go: Nodex's own processes by role, and everything they run as `work`. */
export type ProcessGroupKey = "main" | ElectronProcessKind | "core" | "agent-runtime" | "work";

export interface ProcessFamily {
  readonly mainPid: number;
  readonly corePid: number | null;
  readonly agentRuntimePids: readonly number[];
  readonly electron: readonly ElectronProcess[];
}

const self = (pid: number) => ({ pid, self: true, descendants: false });

/**
 * Main and each helper count only themselves; Core counts with anything it starts. `work` is
 * everything else below Main, including what the Agent Runtime runs for Agents.
 */
export function processGroupsFor(family: ProcessFamily): ProcessGroupRequest[] {
  const electron = (kind: ElectronProcessKind) => ({
    key: kind,
    roots: family.electron.filter((entry) => entry.kind === kind).map((entry) => self(entry.pid)),
  });
  return [
    { key: "main", roots: [self(family.mainPid)] },
    electron("renderer"),
    electron("gpu"),
    electron("utility"),
    electron("other"),
    {
      key: "core",
      roots:
        family.corePid === null ? [] : [{ pid: family.corePid, self: true, descendants: true }],
    },
    { key: "agent-runtime", roots: family.agentRuntimePids.map(self) },
    { key: "work", roots: [{ pid: family.mainPid, self: false, descendants: true }] },
  ];
}

const round = (value: number, digits = 1) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

export interface ProcessGroupHealth {
  readonly processes: number;
  readonly cpuPercent: number | null;
  readonly rssMb: number | null;
}

/** Groups without processes are left out, so a reading lists only what ran. */
export const processHealth = (
  groups: readonly ProcessGroupReading[],
): Partial<Record<string, ProcessGroupHealth>> =>
  Object.fromEntries(
    groups
      .filter((group) => group.processes > 0)
      .map((group) => [
        group.key,
        {
          processes: group.processes,
          cpuPercent: group.cpuPercent,
          rssMb: group.rssKb === null ? null : round(group.rssKb / 1024),
        },
      ]),
  );

/** How late Main's timers ran: a measure of how long Main's event loop stayed busy. */
export interface EventLoopHealth {
  readonly delayMs: {
    readonly p50: number;
    readonly p90: number;
    readonly p99: number;
    readonly max: number;
    readonly mean: number;
  } | null;
}

export interface DelayHistogram {
  readonly count: number;
  readonly mean: number;
  readonly max: number;
  percentile(percentile: number): number;
}

/**
 * The histogram records the time between timer callbacks, which includes the timer's own
 * resolution; the delay is what exceeds it.
 */
export const eventLoopHealth = (
  histogram: DelayHistogram,
  resolutionMs: number,
): EventLoopHealth => {
  const delay = (nanos: number) => round(Math.max(0, nanos / 1e6 - resolutionMs));
  return {
    delayMs:
      histogram.count === 0
        ? null
        : {
            p50: delay(histogram.percentile(50)),
            p90: delay(histogram.percentile(90)),
            p99: delay(histogram.percentile(99)),
            max: delay(histogram.max),
            mean: delay(histogram.mean),
          },
  };
};

export interface CoreHealthReading {
  readonly requests: number;
  readonly executionMs: number | null;
  readonly admissionWaitMs: number | null;
  readonly writerCommands: number;
  readonly writerQueueWaitMs: number | null;
  readonly transactionMs: number | null;
  readonly overloaded: number;
  readonly deadlineExceeded: number;
  /** Current queue depths, not interval totals. */
  readonly queuedRequests: number;
  readonly writerQueueDepth: number;
  readonly walMb: number;
  readonly documentCacheHitRate: number | null;
}

const EMPTY_DURATION: HealthDurationMetric = {
  count: 0,
  total_micros: 0,
  max_micros: 0,
  last_micros: 0,
};

/** Mean of the durations recorded during the interval. */
const intervalMeanMs = (
  current: HealthDurationMetric | undefined,
  previous: HealthDurationMetric | undefined,
) => {
  const now = current ?? EMPTY_DURATION;
  const before = previous ?? EMPTY_DURATION;
  const count = now.count - before.count;
  return count > 0 ? round((now.total_micros - before.total_micros) / count / 1_000, 2) : null;
};

/**
 * Core's cumulative counters as what happened during the interval. Without a previous reading
 * from the same Core process, the interval starts when that process did.
 */
export function coreHealth(
  current: CoreHealthMetrics,
  previous: CoreHealthMetrics | null,
): CoreHealthReading {
  const delta = (read: (metrics: CoreHealthMetrics) => number | undefined) =>
    (read(current) ?? 0) - (previous ? (read(previous) ?? 0) : 0);
  const hits = delta((metrics) => metrics.document_cache_hits);
  const misses = delta((metrics) => metrics.document_cache_misses);
  return {
    requests: delta((metrics) => metrics.request_execution_duration?.count),
    executionMs: intervalMeanMs(
      current.request_execution_duration,
      previous?.request_execution_duration,
    ),
    admissionWaitMs: intervalMeanMs(
      current.request_admission_wait,
      previous?.request_admission_wait,
    ),
    writerCommands: delta((metrics) => metrics.writer_execution.count),
    writerQueueWaitMs: intervalMeanMs(current.writer_queue_wait, previous?.writer_queue_wait),
    transactionMs: intervalMeanMs(current.transaction_duration, previous?.transaction_duration),
    overloaded: delta((metrics) => metrics.request_overloaded),
    deadlineExceeded: delta((metrics) => metrics.request_deadline_exceeded),
    queuedRequests: current.queued_requests ?? 0,
    writerQueueDepth: current.writer_queue_depth,
    walMb: round(current.wal_size_bytes / 1024 / 1024),
    documentCacheHitRate: hits + misses > 0 ? round(hits / (hits + misses), 3) : null,
  };
}
