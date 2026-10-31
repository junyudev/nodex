import { useEffect } from "react";

const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Moves a view's clock to the present once `at` passes: the next moment the view changes without
 * new data, such as a usage window resetting or its reading going stale.
 */
export function useClockAt(at: number | null, setNow: (now: number) => void): void {
  useEffect(() => {
    if (at === null) return;
    const timeout = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(at - Date.now(), 0) + 50, MAX_TIMEOUT_MS),
    );
    return () => window.clearTimeout(timeout);
  }, [at, setNow]);
}
