import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import TimingReporter from "./vitest-timing-reporter";

test.each([
  "An update to Component inside a test was not wrapped in act(...).",
  "The current testing environment is not configured to support act(...).",
  "You seem to have overlapping act() calls, this is not supported.",
  "You called act(async () => ...) without await.",
  "A component suspended inside an `act` scope, but the `act` call was not awaited.",
])("rejects unsettled React interactions without timing artifacts: %s", async (content) => {
  const reporter = new TimingReporter({ suite: "renderer" });
  reporter.onUserConsoleLog({ type: "stderr", content, time: 0, size: 1 });
  await expect(reporter.onTestRunEnd([], [], "passed")).rejects.toThrow(
    "React act warnings invalidate this test run",
  );
});

test("accepts a settled run without timing artifacts", async () => {
  const reporter = new TimingReporter({ suite: "renderer" });
  reporter.onUserConsoleLog({
    type: "stdout",
    content: "Completed the interaction.",
    time: 0,
    size: 1,
  });
  await expect(reporter.onTestRunEnd([], [], "passed")).resolves.toBeUndefined();
});

test("allows a corrected watch run to pass after the previous run warned", async () => {
  const reporter = new TimingReporter({ suite: "renderer" });
  reporter.onUserConsoleLog({
    type: "stderr",
    content: "An update to Component inside a test was not wrapped in act(...).",
    time: 0,
    size: 1,
  });
  await expect(reporter.onTestRunEnd([], [], "passed")).rejects.toThrow("act warnings invalidate");
  reporter.onTestRunStart();
  await expect(reporter.onTestRunEnd([], [], "passed")).resolves.toBeUndefined();
});

test("retains evidence but rejects a nominally passed sample with a React act warning", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nodex-timing-reporter-"));
  try {
    const reporter = new TimingReporter({ directory, suite: "renderer" });
    reporter.onUserConsoleLog({
      type: "stderr",
      content: "An update to Component inside a test was not wrapped in act(...).",
      time: 0,
      size: 1,
    });
    await expect(reporter.onTestRunEnd([], [], "passed")).rejects.toThrow(
      "act warnings invalidate",
    );
    const report = JSON.parse(
      await readFile(path.join(directory, "renderer-" + process.pid + ".json"), "utf8"),
    );
    expect(report.reactActWarnings).toHaveLength(1);
    expect(report.reason).toBe("passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
