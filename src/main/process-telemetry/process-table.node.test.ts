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
