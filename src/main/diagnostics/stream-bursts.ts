import * as Context from "effect/Context";
import { isDevRuntimeMetricsEnabled } from "../dev-runtime-metrics";

export interface StreamBurstOptions {
  readonly windowMs?: number;
  /** Inbound bytes within one window that make a burst. */
  readonly bytes?: number;
  /** Inbound frames within one window that make a burst. */
  readonly frames?: number;
  /** At most one burst is reported per this long. */
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

export interface StreamBursts {
  /** Counts one inbound stream frame. */
  readonly observe: (bytes: number) => void;
  readonly onBurst: (listener: () => void) => () => void;
}

/** Fixed windows keep observation to two additions and a comparison per frame. */
export function createStreamBursts(options: StreamBurstOptions = {}): StreamBursts {
  const windowMs = options.windowMs ?? 1_000;
  const byteLimit = options.bytes ?? 512 * 1024;
  const frameLimit = options.frames ?? 200;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let windowStart = Number.NEGATIVE_INFINITY;
  let bytes = 0;
  let frames = 0;
  let quietUntil = Number.NEGATIVE_INFINITY;
  return {
    observe(frameBytes) {
      const at = now();
      if (at - windowStart >= windowMs) {
        windowStart = at;
        bytes = 0;
        frames = 0;
      }
      bytes += frameBytes;
      frames += 1;
      if ((bytes < byteLimit && frames < frameLimit) || at < quietUntil) return;
      quietUntil = at + cooldownMs;
      for (const listener of listeners) listener();
    },
    onBurst(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Runtime stream bursts for health readings. Present only with development runtime metrics, so
 * the stream path pays one null check otherwise.
 */
export const MainStreamBursts = Context.Reference<StreamBursts | null>(
  "nodex/main/diagnostics/MainStreamBursts",
  { defaultValue: () => (isDevRuntimeMetricsEnabled() ? createStreamBursts() : null) },
);
