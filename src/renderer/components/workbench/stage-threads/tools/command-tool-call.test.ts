import { describe, expect, test } from "bun:test";
import { formatCommandMetaText, reconcileCommandElapsedSnapshot } from "./command-tool-call";

describe("reconcileCommandElapsedSnapshot", () => {
  test("updates the live tick while a command is running", () => {
    const next = reconcileCommandElapsedSnapshot(
      {
        startedAt: 1_000,
        settledElapsedMs: null,
        lastMeasuredAt: 1_000,
      },
      "inProgress",
      2_500,
    );

    expect(next.startedAt).toBe(1_000);
    expect(next.settledElapsedMs).toBe(null);
    expect(next.lastMeasuredAt).toBe(2_500);
  });

  test("snapshots elapsed once when the command settles", () => {
    const next = reconcileCommandElapsedSnapshot(
      {
        startedAt: 1_000,
        settledElapsedMs: null,
        lastMeasuredAt: 2_500,
      },
      "completed",
      4_000,
    );

    expect(next.startedAt).toBe(null);
    expect(next.settledElapsedMs).toBe(3_000);
    expect(next.lastMeasuredAt).toBe(4_000);
  });

  test("keeps the snapped elapsed time fixed after settlement", () => {
    const snapshot = {
      startedAt: null,
      settledElapsedMs: 3_000,
      lastMeasuredAt: 4_000,
    };

    const next = reconcileCommandElapsedSnapshot(snapshot, "completed", 9_000);
    expect(next.startedAt).toBe(snapshot.startedAt);
    expect(next.settledElapsedMs).toBe(snapshot.settledElapsedMs);
    expect(next.lastMeasuredAt).toBe(snapshot.lastMeasuredAt);
  });
});

describe("formatCommandMetaText", () => {
  test("keeps the elapsed prefix for settled commands", () => {
    expect(formatCommandMetaText("2m 9s", undefined)).toBe("for 2m 9s");
  });

  test("joins elapsed and cwd details consistently", () => {
    expect(formatCommandMetaText("15s", "in /tmp/repo")).toBe("for 15s · in /tmp/repo");
  });
});
