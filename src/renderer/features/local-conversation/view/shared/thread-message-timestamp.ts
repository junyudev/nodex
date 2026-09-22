import { footerLocale } from "./thread-footer-i18n";

const RECENT_PAST_DAY_COUNT = 7;
const DAY_MS = 86_400_000;

type TimestampValue = number | null | undefined;

function resolveFiniteTimestampMs(value: TimestampValue): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getCalendarDayOffset(left: Date, right: Date): number {
  const leftDayStart = new Date(left.getFullYear(), left.getMonth(), left.getDate());
  const rightDayStart = new Date(right.getFullYear(), right.getMonth(), right.getDate());
  return Math.round((leftDayStart.getTime() - rightDayStart.getTime()) / DAY_MS);
}

function formatDateTime(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(footerLocale(), options).format(date);
}

export function formatThreadMessageTimestamp(
  sentAtMs: TimestampValue,
  nowMs = Date.now(),
): string | null {
  const resolvedSentAtMs = resolveFiniteTimestampMs(sentAtMs);
  if (resolvedSentAtMs === null) return null;

  const resolvedNowMs = resolveFiniteTimestampMs(nowMs) ?? Date.now();
  const sentAt = new Date(resolvedSentAtMs);

  const dayOffset = getCalendarDayOffset(sentAt, new Date(resolvedNowMs));

  if (dayOffset === 0) {
    return formatDateTime(sentAt, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  if (dayOffset < 0 && dayOffset > -RECENT_PAST_DAY_COUNT) {
    return formatDateTime(sentAt, {
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return formatDateTime(sentAt, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
