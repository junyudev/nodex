import { getIntl } from "@/lib/i18n";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Formats elapsed time as `now`, `5m`, `3h`, `2d`, `3w`, then a short date after 30 days. */
export function formatCompactRelativeTime(timestampMs: number, nowMs = Date.now()): string {
  if (!Number.isFinite(timestampMs)) return "";
  const elapsedMs = Math.max(0, nowMs - timestampMs);
  if (elapsedMs < MINUTE_MS)
    return getIntl().formatMessage({
      id: "lib.compactRelativeTime.justNow",
      defaultMessage: "now",
    });
  if (elapsedMs < HOUR_MS)
    return getIntl().formatMessage(
      { id: "lib.compactRelativeTime.minutes", defaultMessage: "{count}m" },
      { count: Math.floor(elapsedMs / MINUTE_MS) },
    );
  if (elapsedMs < DAY_MS)
    return getIntl().formatMessage(
      { id: "lib.compactRelativeTime.hours", defaultMessage: "{count}h" },
      { count: Math.floor(elapsedMs / HOUR_MS) },
    );
  if (elapsedMs < WEEK_MS)
    return getIntl().formatMessage(
      { id: "lib.compactRelativeTime.days", defaultMessage: "{count}d" },
      { count: Math.floor(elapsedMs / DAY_MS) },
    );
  if (elapsedMs < 30 * DAY_MS)
    return getIntl().formatMessage(
      { id: "lib.compactRelativeTime.weeks", defaultMessage: "{count}w" },
      { count: Math.floor(elapsedMs / WEEK_MS) },
    );
  return getIntl().formatDate(timestampMs, { month: "short", day: "numeric" });
}
