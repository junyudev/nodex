import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_REPLACEMENT_COUNT,
  DEFAULT_TASK_CYCLE_COUNT,
  percentile,
  resolveOutputPath,
  runStateBenchmark,
  summarize,
} from "./benchmark-remote-hosted-pip.mjs";

describe("Remote Hosted PiP state evidence benchmark", () => {
  test("keeps the release pressure defaults explicit", () => {
    expect(DEFAULT_REPLACEMENT_COUNT).toBe(1_000);
    expect(DEFAULT_TASK_CYCLE_COUNT).toBe(100);
  });

  test("reports nearest-rank latency summaries", () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([4, 1, 3, 2], 0.95)).toBe(4);
    expect(summarize([4, 1, 3, 2])).toEqual({ count: 4, p50Ms: 2, p95Ms: 4 });
  });

  test("writes only to the requested evidence artifact path", () => {
    expect(resolveOutputPath(["--out=./runs.local/pip-evidence.json"])).toBe(
      path.resolve("runs.local/pip-evidence.json"),
    );
  });

  test("proves bounded Main state and teardown without claiming signed-native parity", async () => {
    const report = await runStateBenchmark({ replacementCount: 12, taskCycleCount: 4 });

    expect(report).toMatchObject({
      evidence: {
        grade: "state-only",
        productionBrowserTouched: false,
        productionWindowTouched: false,
        signedNative: false,
      },
      isolation: {
        acceptedLocalCodexOccurrences: 1,
        activeTaskIds: ["local-thread"],
        attemptedOccurrences: 3,
        rejectedNonLocalOccurrences: 2,
      },
      replacementCount: 12,
      schemaVersion: 1,
      status: "passed",
      taskCycleCount: 4,
      windowOwnership: {
        afterTeardown: {
          auxiliaryWindowCount: 0,
          listenerCount: 0,
          primaryWindowCount: 0,
          registryEntryCount: 0,
        },
        beforeTeardown: {
          auxiliaryWindowCount: 1,
          primaryWindowCount: 3,
          registryEntryCount: 4,
        },
      },
    });
    expect(report.benchmarks.resourceGovernor).toMatchObject({
      lifecycle: { count: 4 },
      replacement: { count: 12 },
      retained: {
        finalDecodedBytes: 0,
        finalPresentationCount: 0,
        peakDecodedBytes: 4,
        peakPresentationCount: 1,
      },
    });
    expect(report.benchmarks.runtimeProjection).toMatchObject({
      lifecycle: { count: 4 },
      nativeFake: {
        finalPresentationCount: 0,
        peakPresentationCount: 1,
        upsertCount: 16,
      },
      replacement: { count: 12 },
      retained: {
        activeBeforeHostRetirement: 1,
        finalActiveTaskCount: 0,
        finalPresentationCount: 0,
        peakPresentationCount: 1,
      },
    });
    expect(report.memory.samples.map((sample) => sample.stage)).toEqual([
      "start",
      "after-resource-governor",
      "after-backend-isolation",
      "after-runtime-projection",
      "after-window-ownership-teardown",
    ]);
    expect(report.memory.peakRssBytes).toBeGreaterThan(0);
    expect(report.evidence.doesNotProve).toHaveLength(3);
    expect(report.evidence.requiredExternalGates).toHaveLength(4);
    expect(report.benchmarks.runtimeProjection.memorySamples).toHaveLength(9);
    expect(
      report.benchmarks.runtimeProjection.memorySamples.every(
        (sample) =>
          sample.retainedPresentationCount <= 1 && sample.fakeNativePresentationCount <= 1,
      ),
    ).toBe(true);
  });
});
