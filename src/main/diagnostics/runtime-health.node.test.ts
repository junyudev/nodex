import { describe, expect, test } from "vite-plus/test";
import type { components } from "@nodex/core-protocol";
import { readProcessGroups } from "../process-telemetry/process-table";
import { coreHealth, eventLoopHealth, processGroupsFor, processHealth } from "./runtime-health";
import { createStreamBursts } from "./stream-bursts";

type CoreHealthMetrics = components["schemas"]["CoreHealthMetrics"];

const duration = (count: number, totalMs: number) => ({
  count,
  total_micros: totalMs * 1_000,
  max_micros: 0,
  last_micros: 0,
});

const coreMetrics = (scale: number): CoreHealthMetrics =>
  ({
    request_execution_duration: duration(10 * scale, 20 * scale),
    request_admission_wait: duration(10 * scale, 5 * scale),
    writer_execution: duration(4 * scale, 8 * scale),
    writer_queue_wait: duration(4 * scale, 2 * scale),
    transaction_duration: duration(4 * scale, 12 * scale),
    request_overloaded: scale,
    request_deadline_exceeded: 0,
    queued_requests: 3,
    writer_queue_depth: 1,
    wal_size_bytes: 3 * 1024 * 1024,
    document_cache_hits: 9 * scale,
    document_cache_misses: scale,
  }) as CoreHealthMetrics;

describe("runtime health", () => {
  test("attributes each Nodex process by role and the rest as work", () => {
    const rows = [
      [10, 1],
      [11, 10],
      [12, 10],
      [13, 10],
      [14, 13],
      [15, 13],
      [16, 10],
      [50, 1],
    ].map(([pid, parentPid]) => ({
      pid: pid!,
      parentPid: parentPid!,
      cpuSeconds: 0,
      cpuPercent: 2,
      rssKb: 1024,
    }));
    const groups = readProcessGroups(
      { sampledAtMs: 0, rows: new Map(rows.map((row) => [row.pid, row])) },
      processGroupsFor({
        mainPid: 10,
        corePid: 50,
        agentRuntimePids: [13],
        electron: [
          { pid: 11, kind: "renderer" },
          { pid: 12, kind: "gpu" },
        ],
      }),
      null,
    );
    expect(processHealth(groups)).toEqual({
      main: { processes: 1, cpuPercent: 2, rssMb: 1 },
      renderer: { processes: 1, cpuPercent: 2, rssMb: 1 },
      gpu: { processes: 1, cpuPercent: 2, rssMb: 1 },
      core: { processes: 1, cpuPercent: 2, rssMb: 1 },
      "agent-runtime": { processes: 1, cpuPercent: 2, rssMb: 1 },
      // The Runtime's two children and Main's other child.
      work: { processes: 3, cpuPercent: 6, rssMb: 3 },
    });
  });

  test("reports Core's counters as the interval's activity", () => {
    expect(coreHealth(coreMetrics(3), coreMetrics(1))).toEqual({
      requests: 20,
      executionMs: 2,
      admissionWaitMs: 0.5,
      writerCommands: 8,
      writerQueueWaitMs: 0.5,
      transactionMs: 3,
      overloaded: 2,
      deadlineExceeded: 0,
      queuedRequests: 3,
      writerQueueDepth: 1,
      walMb: 3,
      documentCacheHitRate: 0.9,
    });
    // A new Core process: the interval starts when it did.
    expect(coreHealth(coreMetrics(1), null)).toMatchObject({ requests: 10, overloaded: 1 });
    expect(coreHealth(coreMetrics(1), coreMetrics(1))).toMatchObject({
      requests: 0,
      executionMs: null,
      documentCacheHitRate: null,
    });
  });

  test("reads how late Main's timers ran, in milliseconds", () => {
    const histogram = {
      count: 100,
      mean: 11_000_000,
      max: 250_000_000,
      percentile: (value: number) => value * 200_000,
    };
    // Less the 10 ms timer resolution the histogram includes.
    expect(eventLoopHealth(histogram, 10)).toEqual({
      delayMs: { p50: 0, p90: 8, p99: 9.8, max: 240, mean: 1 },
    });
    expect(eventLoopHealth({ ...histogram, count: 0 }, 10).delayMs).toBeNull();
  });

  test("reports a stream burst once per cooldown", () => {
    let now = 0;
    let bursts = 0;
    const detector = createStreamBursts({
      windowMs: 1_000,
      bytes: 1_000,
      frames: 10,
      cooldownMs: 10_000,
      now: () => now,
    });
    detector.onBurst(() => (bursts += 1));
    for (let index = 0; index < 9; index += 1) detector.observe(10);
    expect(bursts).toBe(0);
    detector.observe(10);
    expect(bursts).toBe(1);
    detector.observe(5_000);
    expect(bursts).toBe(1);
    now = 2_000;
    // A new window below both limits.
    detector.observe(999);
    expect(bursts).toBe(1);
    now = 10_000;
    detector.observe(1_000);
    expect(bursts).toBe(2);
  });
});
