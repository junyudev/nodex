import { describe, expect, test } from "vite-plus/test";
import {
  classifyRealRuntimeStatus,
  classifyElectronProcess,
  parseFootprintOutput,
  parseProcessTable,
  parseRealRuntimeOptions,
  runRealRuntimeBenchmark,
  summarizeResourceSamples,
} from "./benchmark-remote-hosted-pip-real-runtime.mjs";

describe("Remote Hosted PiP real-runtime benchmark", () => {
  test("requires an explicit native-UI opt-in and keeps pressure counts configurable", () => {
    expect(
      parseRealRuntimeOptions([
        "--real-runtime",
        "--allow-native-ui",
        "--runtime-root=/tmp/runtime",
        "--replacement-count=12",
        "--task-cycle-count=4",
        "--window-cycle-count=3",
        "--service-reconnect-count=2",
      ]),
    ).toMatchObject({
      allowNativeUi: true,
      replacementCount: 12,
      requested: true,
      runtimeRoot: "/tmp/runtime",
      serviceReconnectCount: 2,
      taskCycleCount: 4,
      windowCycleCount: 3,
    });
  });

  test("parses macOS RSS and physical-footprint evidence without guessing missing values", () => {
    expect(
      parseProcessTable(
        " 100 1 2048 S /Applications/Electron.app/Contents/MacOS/Electron\n" +
          " 101 100 512 R /Applications/Electron Helper.app --type=renderer",
      ),
    ).toEqual([
      {
        command: "/Applications/Electron.app/Contents/MacOS/Electron",
        pid: 100,
        ppid: 1,
        rssBytes: 2_097_152,
        state: "S",
      },
      {
        command: "/Applications/Electron Helper.app --type=renderer",
        pid: 101,
        ppid: 100,
        rssBytes: 524_288,
        state: "R",
      },
    ]);
    expect(
      parseFootprintOutput(
        "app [100]: 64-bit Footprint: 123 B\n  phys_footprint: 456 B\n  phys_footprint_peak: 789 B",
      ),
    ).toEqual({ footprintBytes: 456, footprintPeakBytes: 789 });
    expect(parseFootprintOutput("permission denied")).toBeNull();
  });

  test("attributes Electron children by the verified process command", () => {
    expect(
      classifyElectronProcess(
        { command: "Electron Helper --type=renderer", pid: 101, ppid: 100 },
        100,
      ),
    ).toBe("electron-renderer");
    expect(
      classifyElectronProcess(
        { command: "Electron Helper --type=gpu-process", pid: 102, ppid: 100 },
        100,
      ),
    ).toBe("electron-gpu");
    expect(classifyElectronProcess({ command: "Electron", pid: 100, ppid: 1 }, 100)).toBe(
      "electron-main",
    );
  });

  test("fails closed when native startup or any workload fails", () => {
    expect(
      classifyRealRuntimeStatus({
        hardGatePassed: true,
        nativeHostPassed: false,
        workloadStatuses: ["passed", "passed"],
      }),
    ).toBe("failed");
    expect(
      classifyRealRuntimeStatus({
        hardGatePassed: true,
        nativeHostPassed: true,
        workloadStatuses: ["passed", "failed"],
      }),
    ).toBe("failed");
    expect(
      classifyRealRuntimeStatus({
        hardGatePassed: true,
        nativeHostPassed: true,
        workloadStatuses: ["passed", "unavailable"],
      }),
    ).toBe("partial");
  });

  test("reports baseline, peak, recovery, p50 and p95 per resource owner", () => {
    const summary = summarizeResourceSamples([
      {
        stage: "baseline",
        processes: [
          { footprintBytes: 80, role: "electron-main", rssBytes: 100 },
          { footprintBytes: 30, role: "electron-renderer", rssBytes: 50 },
        ],
      },
      {
        stage: "pressure",
        processes: [
          { footprintBytes: 120, role: "electron-main", rssBytes: 200 },
          { footprintBytes: 40, role: "electron-renderer", rssBytes: 75 },
        ],
      },
      {
        stage: "after-native-teardown",
        processes: [{ footprintBytes: 90, role: "electron-main", rssBytes: 110 }],
      },
    ]);

    expect(summary.total).toMatchObject({
      baselineRssBytes: 150,
      peakRssBytes: 275,
      recoveryRssBytes: 110,
      rss: { count: 3, p50: 150, p95: 275 },
    });
    expect(summary["electron-main"]).toMatchObject({
      baselineFootprintBytes: 80,
      baselineRssBytes: 100,
      peakFootprintBytes: 120,
      peakRssBytes: 200,
      recoveryFootprintBytes: 90,
      recoveryRssBytes: 110,
      rssWhenPresent: { count: 3, p50: 110, p95: 200 },
    });
  });

  test("CI without an artifact returns a machine-readable skip without touching native UI", async () => {
    await expect(
      runRealRuntimeBenchmark({
        allowNativeUi: false,
        electronExecutable: null,
        replacementCount: 1_000,
        requested: true,
        runtimeRoot: null,
        serviceReconnectCount: 3,
        taskCycleCount: 100,
        timeoutMs: 1_000,
        windowCycleCount: 100,
      }),
    ).resolves.toMatchObject({
      evidence: {
        productionBrowserTouched: false,
        productionProfileTouched: false,
        signedNative: false,
      },
      reason: "native-ui-opt-in-required",
      schemaVersion: 2,
      status: "skipped",
    });
  });

  test("an opted-in run without a staged runtime skips before launching Electron", async () => {
    await expect(
      runRealRuntimeBenchmark({
        allowNativeUi: true,
        electronExecutable: null,
        replacementCount: 1_000,
        requested: true,
        runtimeRoot: null,
        serviceReconnectCount: 3,
        taskCycleCount: 100,
        timeoutMs: 1_000,
        windowCycleCount: 100,
      }),
    ).resolves.toMatchObject({
      reason: "runtime-root-not-provided",
      schemaVersion: 2,
      status: "skipped",
    });
  });
});
