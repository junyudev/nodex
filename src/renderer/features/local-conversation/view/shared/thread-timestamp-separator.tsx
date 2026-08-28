import { useState } from "react";

const DAY_MS = 24 * 60 * 60 * 1_000;

function getCalendarDayDifference(left: Date, right: Date): number {
  return (
    (Date.UTC(left.getFullYear(), left.getMonth(), left.getDate()) -
      Date.UTC(right.getFullYear(), right.getMonth(), right.getDate())) /
    DAY_MS
  );
}

function formatDate(
  date: Date,
  options: Intl.DateTimeFormatOptions,
  locale?: Intl.LocalesArgument,
): string {
  return new Intl.DateTimeFormat(locale, options).format(date);
}

export interface ThreadTimestampSeparatorLabel {
  readonly date: string;
  readonly time: string;
  readonly includeAt: boolean;
  readonly label: string;
}

export function formatThreadTimestampSeparator(
  sentAtMs: number,
  nowMs: number,
  locale?: Intl.LocalesArgument,
): ThreadTimestampSeparatorLabel {
  const sentAt = new Date(sentAtMs);
  const now = new Date(nowMs);
  const ageDays = Math.max(getCalendarDayDifference(now, sentAt), 0);
  let date: string;

  if (ageDays <= 1) {
    const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    date = relativeTime.format(-ageDays, "day");
    if (relativeTime.resolvedOptions().locale.startsWith("en")) {
      date = `${date.charAt(0).toUpperCase()}${date.slice(1)}`;
    }
  } else if (ageDays <= 7) {
    date = formatDate(sentAt, { weekday: "long" }, locale);
  } else if (ageDays <= 365) {
    date = formatDate(sentAt, { weekday: "short", month: "short", day: "numeric" }, locale);
  } else {
    date = formatDate(sentAt, { month: "short", day: "numeric", year: "numeric" }, locale);
  }

  const time = formatDate(sentAt, { hour: "numeric", minute: "2-digit" }, locale);
  const includeAt = ageDays > 7;
  return {
    date,
    time,
    includeAt,
    label: includeAt ? `${date} at ${time}` : `${date} ${time}`,
  };
}

export function ThreadTimestampSeparator({
  sentAtMs,
  nowMs,
}: {
  readonly sentAtMs: number;
  readonly nowMs?: number;
}) {
  const [mountedAtMs] = useState(() => Date.now());
  if (!Number.isFinite(sentAtMs)) return null;

  const timestamp = formatThreadTimestampSeparator(sentAtMs, nowMs ?? mountedAtMs);
  return (
    <div aria-label={timestamp.label} className="flex justify-center py-4" role="separator">
      <time
        className="text-sm leading-5 font-normal text-tertiary select-none"
        dateTime={new Date(sentAtMs).toISOString()}
      >
        <span className="font-medium">{timestamp.date}</span>{" "}
        {timestamp.includeAt ? `at ${timestamp.time}` : timestamp.time}
      </time>
    </div>
  );
}
