import { describe, expect, test } from "vite-plus/test";
import {
  formatCommandElapsedDuration,
  reconcileCommandElapsedSnapshot,
  resolveCommandSummaryLabel,
} from "./command-tool-call";

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

describe("command elapsed summaries", () => {
  test.each([
    [-1, null],
    [999, null],
    [1_999, "1s"],
    [60_000, "1m 0s"],
    [3_600_000, "1h 0m 0s"],
    [86_400_000, "1d 0h 0m 0s"],
  ])("formats %s ms with complete elapsed units", (duration, label) => {
    expect(formatCommandElapsedDuration(duration as number)).toBe(label);
  });

  test.each([
    ["inProgress", false, "Running command for 5s"],
    ["completed", false, "Ran bun test in 5s"],
    ["failed", false, "Ran bun test in 5s"],
    ["interrupted", false, "Stopped bun test after 5s"],
    ["completed", true, "Ran command in 5s"],
    ["interrupted", true, "Stopped command after 5s"],
  ] as const)(
    "uses lifecycle-aware elapsed wording for %s expanded=%s",
    (effectiveStatus, isExpanded, label) => {
      expect(
        resolveCommandSummaryLabel({
          command: "bun test",
          elapsedLabel: "5s",
          effectiveStatus,
          isExpanded,
          isTurnInProgress: true,
          processId: null,
        }),
      ).toBe(label);
    },
  );

  test.each([
    [
      "inProgress",
      "Started background terminal with bun test",
      "Checking the current date and time for 5s",
    ],
    ["completed", "Ran bun test", "Checked the current date and time in 5s"],
    [
      "interrupted",
      "Background terminal stopped with bun test",
      "Stopped checking the current date and time after 5s",
    ],
  ] as const)(
    "omits background elapsed except date commands for %s",
    (effectiveStatus, commandLabel, dateLabel) => {
      const input = {
        elapsedLabel: "5s",
        effectiveStatus,
        isExpanded: false,
        isTurnInProgress: false,
        processId: "123",
      };
      expect(resolveCommandSummaryLabel({ ...input, command: "bun test" })).toBe(commandLabel);
      expect(resolveCommandSummaryLabel({ ...input, command: "date -u" })).toBe(dateLabel);
    },
  );

  test("prioritizes auto-review refusal over command type, elapsed, and background state", () => {
    const input = {
      command: "date -u",
      elapsedLabel: "5s",
      effectiveStatus: "declined",
      isTurnInProgress: false,
      processId: "123",
      wasDeclinedByAutoReview: true,
    };
    expect(resolveCommandSummaryLabel({ ...input, isExpanded: false })).toBe(
      "Command declined by auto-review: date -u",
    );
    expect(resolveCommandSummaryLabel({ ...input, isExpanded: true })).toBe(
      "Command declined by auto-review",
    );
  });
});
