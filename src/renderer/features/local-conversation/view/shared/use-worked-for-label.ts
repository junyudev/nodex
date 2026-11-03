import { useCallback, useState, useSyncExternalStore } from "react";
import {
  resolveWorkedForLabelText,
  type ThreadWorkedForTiming,
} from "../../thread-worked-for-time";

export function useWorkedForLabelText({
  timing,
  durationMs,
  fallbackTimeLabel = null,
}: {
  timing: ThreadWorkedForTiming | null;
  durationMs: number | null;
  fallbackTimeLabel?: string | null;
}): string | null {
  const isWorking = timing?.status === "working" && timing.completedAtMs === null;
  const [clock] = useState(() => {
    let nowMs = Date.now();
    return {
      read: () => nowMs,
      tick: () => {
        nowMs = Date.now();
      },
    };
  });
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!isWorking) return () => {};
      clock.tick();
      const intervalId = window.setInterval(() => {
        clock.tick();
        notify();
      }, 1000);
      return () => window.clearInterval(intervalId);
    },
    [clock, isWorking],
  );
  const nowMs = useSyncExternalStore(subscribe, clock.read, clock.read);

  return resolveWorkedForLabelText({
    timing,
    durationMs,
    fallbackTimeLabel,
    nowMs,
  });
}
