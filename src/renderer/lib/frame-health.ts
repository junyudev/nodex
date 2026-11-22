import type { RendererFrameHealth } from "../../shared/diagnostics/frame-health";
import { invokeRendererControl } from "./renderer-command";

const REPORT_EVERY_MS = 60_000;

/** The parts of a long-animation-frame entry this window reports. */
export interface LongFrame {
  readonly startTime: number;
  readonly duration: number;
  readonly blockingDuration: number;
  /** Zero when the frame did not reach style and layout. */
  readonly styleAndLayoutStart: number;
  readonly scripts: readonly {
    readonly duration: number;
    readonly invoker: string;
    readonly invokerType: string;
    readonly sourceURL: string;
    readonly sourceFunctionName: string;
  }[];
}

const round = (value: number) => Math.round(value * 10) / 10;

/** The script's file and function, without the origin or query that locate it. */
const sourceOf = (script: LongFrame["scripts"][number]) => {
  const file = script.sourceURL.split(/[?#]/)[0]!.split("/").pop() ?? "";
  return `${file}${script.sourceFunctionName ? `:${script.sourceFunctionName}` : ""}`.slice(0, 160);
};

/** Accumulates one reporting window; `visible` brackets the time frames are counted. */
export function createFrameHealthWindow(now: () => number) {
  let startedAt = now();
  let visibleSince: number | null = null;
  let visibleMs = 0;
  let frames = 0;
  let durationMs = 0;
  let blockingMs = 0;
  let maxDurationMs = 0;
  let maxBlockingMs = 0;
  let worst: RendererFrameHealth["worst"] = null;
  return {
    visible(visible: boolean) {
      if (visible && visibleSince === null) visibleSince = now();
      if (!visible && visibleSince !== null) {
        visibleMs += now() - visibleSince;
        visibleSince = null;
      }
    },
    record(frame: LongFrame) {
      frames += 1;
      durationMs += frame.duration;
      blockingMs += frame.blockingDuration;
      maxBlockingMs = Math.max(maxBlockingMs, frame.blockingDuration);
      if (frame.duration <= maxDurationMs) return;
      maxDurationMs = frame.duration;
      const script = frame.scripts.reduce<LongFrame["scripts"][number] | null>(
        (longest, entry) => (!longest || entry.duration > longest.duration ? entry : longest),
        null,
      );
      worst = {
        durationMs: round(frame.duration),
        layoutMs: frame.styleAndLayoutStart
          ? round(Math.max(0, frame.startTime + frame.duration - frame.styleAndLayoutStart))
          : 0,
        script: script
          ? {
              invoker: `${script.invokerType}:${script.invoker}`.slice(0, 160),
              source: sourceOf(script),
              durationMs: round(script.duration),
            }
          : null,
      };
    },
    /** Ends the window, or returns null when the window was never visible. */
    take(): RendererFrameHealth | null {
      const at = now();
      const visibleTotal = visibleMs + (visibleSince === null ? 0 : at - visibleSince);
      const reading: RendererFrameHealth | null =
        visibleTotal === 0 && frames === 0
          ? null
          : {
              windowMs: Math.round(at - startedAt),
              visibleMs: Math.round(visibleTotal),
              frames,
              durationMs: round(durationMs),
              blockingMs: round(blockingMs),
              maxDurationMs: round(maxDurationMs),
              maxBlockingMs: round(maxBlockingMs),
              worst,
            };
      startedAt = at;
      visibleSince = visibleSince === null ? null : at;
      visibleMs = 0;
      frames = 0;
      durationMs = 0;
      blockingMs = 0;
      maxDurationMs = 0;
      maxBlockingMs = 0;
      worst = null;
      return reading;
    },
  };
}

/**
 * Reports this window's long animation frames to Main once a minute while development runtime
 * metrics are on. Frames are observed only while the window is visible.
 */
export function enableRendererFrameHealth(): void {
  if (!PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) return;
  const current = createFrameHealthWindow(() => performance.now());
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) current.record(entry as unknown as LongFrame);
  });
  const follow = () => {
    const visible = document.visibilityState === "visible";
    if (visible) observer.observe({ type: "long-animation-frame" });
    else {
      for (const entry of observer.takeRecords()) current.record(entry as unknown as LongFrame);
      observer.disconnect();
    }
    current.visible(visible);
  };
  follow();
  document.addEventListener("visibilitychange", follow);
  setInterval(() => {
    const reading = current.take();
    if (reading)
      void invokeRendererControl("diagnostics:renderer-frames", reading).catch(() => undefined);
  }, REPORT_EVERY_MS);
}
