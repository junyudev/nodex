import { describe, expect, test } from "vite-plus/test";
import { createFrameHealthWindow, type LongFrame } from "./frame-health";

const frame = (
  duration: number,
  blockingDuration: number,
  scripts: LongFrame["scripts"] = [],
): LongFrame => ({
  startTime: 1_000,
  duration,
  blockingDuration,
  styleAndLayoutStart: 1_000 + duration - 30,
  scripts,
});
const script = (duration: number, sourceFunctionName: string) => ({
  duration,
  invoker: "BUTTON.onclick",
  invokerType: "event-listener",
  sourceURL: "app://nodex/assets/workbench-abc123.js?v=1",
  sourceFunctionName,
});

describe("renderer frame health window", () => {
  test("reports visible time and the longest frame's longest script", () => {
    let now = 0;
    const window = createFrameHealthWindow(() => now);
    window.visible(true);
    window.record(frame(80, 30, [script(20, "small")]));
    window.record(frame(200, 150, [script(40, "render"), script(120, "layout")]));
    window.record(frame(60, 10));
    now = 1_000;
    window.visible(false);
    now = 5_000;

    expect(window.take()).toEqual({
      windowMs: 5_000,
      visibleMs: 1_000,
      frames: 3,
      durationMs: 340,
      blockingMs: 190,
      maxDurationMs: 200,
      maxBlockingMs: 150,
      worst: {
        durationMs: 200,
        layoutMs: 30,
        script: {
          invoker: "event-listener:BUTTON.onclick",
          source: "workbench-abc123.js:layout",
          durationMs: 120,
        },
      },
    });
  });

  test("stays silent for a window that was never visible, and restarts each window", () => {
    let now = 0;
    const window = createFrameHealthWindow(() => now);
    now = 60_000;
    expect(window.take()).toBeNull();

    window.visible(true);
    now = 90_000;
    expect(window.take()).toMatchObject({ windowMs: 30_000, visibleMs: 30_000, frames: 0 });
    now = 100_000;
    // Still visible: the next window counts from the previous report.
    expect(window.take()).toMatchObject({ windowMs: 10_000, visibleMs: 10_000 });
  });
});
