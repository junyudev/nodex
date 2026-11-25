import { describe, expect, test } from "vite-plus/test";
import {
  collectDescendantPids,
  parseClockSeconds,
  parseUnixProcessTable,
  parseUnixProcessTreeOutput,
  parseWindowsProcessTable,
  readProcessGroups,
  type ProcessRow,
  type ProcessTable,
} from "./process-table";
import { createProcessSampler, readProcessTable } from "./process-sampler";

describe("process-table", () => {
  const row = (pid: number, parentPid: number, cpuSeconds: number, rssKb = 100): ProcessRow => ({
    pid,
    parentPid,
    cpuSeconds,
    cpuPercent: 1,
    rssKb,
  });
  const tableOf = (sampledAtMs: number, rows: readonly ProcessRow[]): ProcessTable => ({
    sampledAtMs,
    rows: new Map(rows.map((entry) => [entry.pid, entry])),
  });

  describe("process table", () => {
    test("reads ps clock times with and without days and fractions", () => {
      expect(parseClockSeconds("0:01.50")).toBe(1.5);
      expect(parseClockSeconds("01:02")).toBe(62);
      expect(parseClockSeconds("12:34:56.78")).toBeCloseTo(45_296.78);
      expect(parseClockSeconds("1-02:03:04")).toBe(93_784);
      expect(parseClockSeconds("")).toBeNull();
      expect(parseClockSeconds("12")).toBeNull();
      expect(parseClockSeconds("a:bc")).toBeNull();
    });

    test("parses unix and windows tables into the same rows", () => {
      expect(
        parseUnixProcessTable(`
        101   100  2.5  0:01.25  1024
        garbage line
        102   101  0.0  1-00:00:00  2048
      `),
      ).toEqual([
        { pid: 101, parentPid: 100, cpuPercent: 2.5, cpuSeconds: 1.25, rssKb: 1024 },
        { pid: 102, parentPid: 101, cpuPercent: 0, cpuSeconds: 86_400, rssKb: 2048 },
      ]);
      expect(
        parseWindowsProcessTable(
          JSON.stringify({
            ProcessId: 7,
            ParentProcessId: 4,
            WorkingSetSize: 4096 * 1024,
            KernelModeTime: 5_000_000,
            UserModeTime: 15_000_000,
          }),
        ),
      ).toEqual([{ pid: 7, parentPid: 4, cpuPercent: null, cpuSeconds: 2, rssKb: 4096 }]);
      expect(parseWindowsProcessTable("not json")).toEqual([]);
    });

    test("collects descendants with or without their root", () => {
      const entries = parseUnixProcessTreeOutput("100 1\n101 100\n102 101\n103 100\n200 1\n");
      const sorted = (pids: number[]) => pids.sort((left, right) => left - right);
      expect(sorted(collectDescendantPids(entries, [{ pid: 100 }]))).toEqual([101, 102, 103]);
      expect(sorted(collectDescendantPids(entries, [{ pid: 100, includeRoot: true }]))).toEqual([
        100, 101, 102, 103,
      ]);
    });

    test("counts each process once, in the first group that reaches it", () => {
      const table = tableOf(1_000, [
        row(10, 1, 0),
        row(11, 10, 0),
        row(12, 11, 0),
        row(13, 10, 0),
        row(50, 1, 0),
      ]);
      const groups = readProcessGroups(
        table,
        [
          { key: "main", roots: [{ pid: 10, self: true, descendants: false }] },
          { key: "runtime", roots: [{ pid: 11, self: true, descendants: false }] },
          { key: "core", roots: [{ pid: 50, self: true, descendants: true }] },
          // Walks through the claimed Runtime to reach its child.
          { key: "rest", roots: [{ pid: 10, self: false, descendants: true }] },
          { key: "gone", roots: [{ pid: 99, self: true, descendants: true }] },
        ],
        null,
      );
      expect(groups.map(({ key, processes, rssKb }) => [key, processes, rssKb])).toEqual([
        ["main", 1, 100],
        ["runtime", 1, 100],
        ["core", 1, 100],
        ["rest", 2, 200],
        ["gone", 0, null],
      ]);
    });

    test("reports CPU over the interval since the baseline", () => {
      const baseline = {
        sampledAtMs: 0,
        cpuSeconds: new Map([
          [1, 10],
          [2, 4],
        ]),
      };
      const table = tableOf(2_000, [row(1, 0, 11), row(2, 0, 3), row(3, 0, 0.5)]);
      const read = (pid: number, withBaseline = true) =>
        readProcessGroups(
          table,
          [{ key: "p", roots: [{ pid, self: true, descendants: false }] }],
          withBaseline ? baseline : null,
        )[0]!.cpuPercent;
      // One CPU second in two seconds.
      expect(read(1)).toBe(50);
      // A reused pid counts from zero.
      expect(read(2)).toBe(150);
      // Started during the interval.
      expect(read(3)).toBe(25);
      // Without a baseline, the platform's recent share.
      expect(read(1, false)).toBe(1);
    });
  });
});

describe("process-sampler", () => {
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
      // macOS `ps` reports CPU time to the hundredth of a second; Linux reports whole seconds,
      // so a test process that has used less than a second reads zero there.
      expect(own?.cpuSeconds).toBeGreaterThanOrEqual(process.platform === "darwin" ? 0.01 : 0);
      expect(own?.rssKb).toBeGreaterThan(0);
    });
  });
});
