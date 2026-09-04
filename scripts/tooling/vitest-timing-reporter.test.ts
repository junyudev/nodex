import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import TimingReporter from "./vitest-timing-reporter";

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
