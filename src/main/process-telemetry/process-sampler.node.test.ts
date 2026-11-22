import { describe, expect, test } from "vite-plus/test";
import { createProcessSampler, readProcessTable } from "./process-sampler";
import type { ProcessRow } from "./process-table";

const groups = [{ key: "p", roots: [{ pid: 1, self: true, descendants: false }] }];

function harness() {
  let now = 0;
  let cpuSeconds = 0;
  let reads = 0;
  const release: (() => void)[] = [];
  const sampler = createProcessSampler({
    now: () => now,
    read: () => {
      reads += 1;
      const rows: ProcessRow[] = [{ pid: 1, parentPid: 0, cpuSeconds, cpuPercent: 7, rssKb: 1 }];
      return new Promise((resolve) => release.push(() => resolve(rows)));
    },
  });
  return {
    sampler,
    reads: () => reads,
    advance: (ms: number, cpu: number) => {
      now += ms;
      cpuSeconds += cpu;
    },
    finish: () => release.splice(0).forEach((resolve) => resolve()),
  };
}

const cpu = async (promise: Promise<{ groups: readonly { cpuPercent: number | null }[] }>) =>
  (await promise).groups[0]!.cpuPercent;

describe("process sampler", () => {
  test("shares one read between concurrent and recent requests", async () => {
    const run = harness();
    const first = run.sampler.sample({ baseline: "a", maxAgeMs: 500, groups });
    const second = run.sampler.sample({ baseline: "b", maxAgeMs: 500, groups });
    run.finish();
    await Promise.all([first, second]);
    expect(run.reads()).toBe(1);

    run.advance(400, 0);
    await run.sampler.sample({ baseline: "a", maxAgeMs: 500, groups });
    expect(run.reads()).toBe(1);

    run.advance(200, 0);
    const later = run.sampler.sample({ baseline: "a", maxAgeMs: 500, groups });
    run.finish();
    await later;
    expect(run.reads()).toBe(2);
  });

  test("keeps a CPU interval per baseline", async () => {
    const run = harness();
    const read = async (baseline: string) => {
      const sample = run.sampler.sample({ baseline, maxAgeMs: 0, groups });
      run.finish();
      return cpu(sample);
    };
    expect(await read("minute")).toBe(7);
    run.advance(1_000, 0.5);
    expect(await read("second")).toBe(7);
    run.advance(1_000, 0.1);
    expect(await read("second")).toBeCloseTo(10);
    // Spans both seconds since its own previous reading.
    expect(
      await cpu(run.sampler.sample({ baseline: "minute", maxAgeMs: 10_000, groups })),
    ).toBeCloseTo(30);
    // A second request answered by the same table reports the same interval.
    expect(
      await cpu(run.sampler.sample({ baseline: "minute", maxAgeMs: 10_000, groups })),
    ).toBeCloseTo(30);
  });
});

describe.skipIf(process.platform === "win32")("process table on this computer", () => {
  test("reads this process with its CPU time and memory", async () => {
    const rows = await readProcessTable(process.platform);
    const own = rows.find((row) => row.pid === process.pid);
    expect(own?.parentPid).toBe(process.ppid);
    expect(own?.cpuSeconds).toBeGreaterThan(0);
    expect(own?.rssKb).toBeGreaterThan(0);
  });
});
