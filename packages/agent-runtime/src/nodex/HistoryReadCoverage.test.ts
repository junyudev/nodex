import { expect, test } from "vitest";
import { makeHistoryReadCoverage } from "./HistoryReadCoverage.ts";
import type { ThreadReadEvidence } from "./history-contracts.ts";

const range = (
  offset: number,
  length: number,
  format: ThreadReadEvidence["format"] = "text",
  version = "v1",
): ThreadReadEvidence => ({
  itemId: "final",
  sourceThreadId: "child",
  format,
  contentVersion: version,
  offset,
  length,
  totalChars: 100,
});
const fixture = (options: Parameters<typeof makeHistoryReadCoverage>[0] = {}) => {
  const cover = makeHistoryReadCoverage(options);
  return (
    evidence: ThreadReadEvidence,
    options: { run?: string; version?: string; now?: number } = {},
  ) =>
    cover({
      callerThreadId: "parent",
      callerRunId: options.run ?? "run-a",
      targetThreadId: "child",
      targetRunId: "result-run",
      evidence,
      currentVersion: options.version ?? "v1",
      totalChars: 100,
      now: options.now ?? 0,
    });
};

test("rejects invalid capacity or lease bounds before accepting read progress", () => {
  for (const options of [
    { maximumItems: 0 },
    { maximumItems: -1 },
    { maximumItems: Infinity },
    { maximumRanges: 0 },
    { idleMs: 0 },
    { idleMs: NaN },
  ])
    expect(() => makeHistoryReadCoverage(options)).toThrow(RangeError);
});

test("requires every range of one current version and format from the same caller Run", () => {
  const cover = fixture();
  expect(cover(range(0, 25))).toBe(false);
  expect(cover(range(75, 25))).toBe(false);
  expect(cover(range(25, 50), { run: "spectator-run" })).toBe(false);
  expect(cover(range(25, 50, "json"))).toBe(false);
  expect(cover({ ...range(25, 50), totalChars: 99 })).toBe(false);
  expect(cover({ ...range(25, 50), length: 100 })).toBe(false);
  expect(cover(range(25, 50))).toBe(true);
  expect(cover(range(0, 100, "text", "v1"), { version: "v2" })).toBe(false);
  expect(cover(range(50, 50, "text", "v2"), { version: "v2" })).toBe(false);
  expect(cover(range(0, 50, "text", "v2"), { version: "v2" })).toBe(true);
});

test("renews active reads while expiry, capacity and sparse-range eviction only discard proofs", () => {
  const cover = fixture({ maximumItems: 2, maximumRanges: 2, idleMs: 100 });
  expect(cover(range(0, 25), { now: 0 })).toBe(false);
  expect(cover(range(25, 25), { now: 75 })).toBe(false);
  expect(cover(range(50, 25), { now: 150 })).toBe(false);
  expect(cover(range(75, 25), { now: 225 })).toBe(true);
  expect(cover(range(75, 25), { now: 400 })).toBe(false);
  expect(cover(range(0, 25), { run: "other", now: 400 })).toBe(false);
  expect(cover(range(0, 25), { run: "third", now: 400 })).toBe(false);
  expect(cover(range(0, 75), { now: 400 })).toBe(false);
  expect(cover(range(75, 25), { now: 400 })).toBe(true);
  const sparse = fixture({ maximumRanges: 2 });
  expect(sparse(range(0, 1))).toBe(false);
  expect(sparse(range(50, 1))).toBe(false);
  expect(sparse(range(99, 1))).toBe(false);
  expect(sparse(range(1, 98))).toBe(false);
  expect(sparse(range(0, 1))).toBe(true);
});
