const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Formats elapsed time as `now`, `5m`, `3h`, `2d`, `3w`, then a short date after 30 days. */
export function formatCompactRelativeTime(timestampMs: number, nowMs = Date.now()): string {
  if (!Number.isFinite(timestampMs)) return "";
  const elapsedMs = Math.max(0, nowMs - timestampMs);
  if (elapsedMs < MINUTE_MS) return "now";
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)}h`;
  if (elapsedMs < WEEK_MS) return `${Math.floor(elapsedMs / DAY_MS)}d`;
  if (elapsedMs < 30 * DAY_MS) return `${Math.floor(elapsedMs / WEEK_MS)}w`;
  return new Date(timestampMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
