import { expect, it } from "vitest";
import { DictationDiagnosticsRecorder } from "./dictation-diagnostics-recorder";
import { dictationTextResult } from "../../../../tests/fixtures/dictation-diagnostics";
import { MAX_DICTATION_DIAGNOSTIC_REQUESTS } from "../../../shared/dictation-diagnostics";

it("keeps recording and overlapping work out of stop-to-text latency and separates clipboard restoration", async () => {
  let now = 0;
  const recorder = new DictationDiagnosticsRecorder(() => now, "global");
  const recording = recorder.phase("recording");
  now = 12_000;
  recorder.stopped();
  recording();
  const remoteWait = recorder.phase("stream-finalize");
  const localSave = recorder.phase("history");
  now = 12_500;
  localSave();
  now = 13_000;
  remoteWait();
  recorder.useTransport("websocket");
  now = 13_850;
  recorder.delivered(700);
  const report = recorder.snapshot("completed");
  expect(report.stopToTextMs).toBe(1_150);
  expect(report.stopToCompletionMs).toBe(1_850);
  expect(report.clipboardRestoreMs).toBe(700);
  expect(report.phases.map((phase) => phase.durationMs)).toEqual([12_000, 500, 1_000]);
  expect(report.phases[1]?.offsetMs).toBe(report.phases[2]?.offsetMs);
});

it("measures a retry from its own start and preserves failed phase timing", async () => {
  let now = 40_000;
  const recorder = new DictationDiagnosticsRecorder(() => now, "history", "recovery", 2);
  await expect(
    recorder.measure("buffered", async () => {
      now += 120;
      throw new Error("network failed");
    }),
  ).rejects.toThrow("network failed");
  expect(recorder.snapshot("failed")).toMatchObject({
    attempt: 2,
    source: "recovery",
    stopOffsetMs: 0,
    phases: [{ stage: "buffered", offsetMs: 0, durationMs: 120, outcome: "failed" }],
  });
  expect(recorder.snapshot("failed").stopToTextMs).toBeUndefined();
});

it("retains separate segment recovery requests and bounds repeated request reports", () => {
  const recorder = new DictationDiagnosticsRecorder(() => 0, "composer");
  const request = dictationTextResult("segment").diagnostics;
  for (let index = 0; index <= MAX_DICTATION_DIAGNOSTIC_REQUESTS; index += 1) {
    recorder.request({
      ...request,
      requestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    });
  }
  const requests = recorder.snapshot("completed").requests;
  expect(requests).toHaveLength(MAX_DICTATION_DIAGNOSTIC_REQUESTS);
  expect(requests[0]?.requestId).toBe("00000000-0000-4000-8000-000000000001");
  recorder.request({ ...requests[0]!, outcome: "failed" });
  expect(recorder.snapshot("failed").requests).toHaveLength(MAX_DICTATION_DIAGNOSTIC_REQUESTS);
  expect(recorder.snapshot("failed").requests.at(-1)?.outcome).toBe("failed");
});
