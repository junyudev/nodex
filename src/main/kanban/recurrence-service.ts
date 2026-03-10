import type {
  Card,
  RecurrenceConfig,
  ReminderConfig,
} from "../../shared/types";

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface RecurrenceException {
  occurrenceStart: Date;
  exceptionType: "skip" | "override_time";
  overrideStart?: Date;
  overrideEnd?: Date;
  overrideReminders?: ReminderConfig[];
}

export interface ExpandedOccurrence {
  occurrenceStart: Date;
  occurrenceEnd: Date;
  reminders: ReminderConfig[];
}

const MAX_GENERATED_OCCURRENCES = 20_000;

function resolveTimezone(timezone?: string): string {
  return timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function getFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function datePartsInTimezone(date: Date, timezone: string): DateParts {
  const parts = getFormatter(timezone).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function dateKeyInTimezone(date: Date, timezone: string): string {
  const parts = datePartsInTimezone(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function shiftDateByDays(parts: DateParts, days: number): DateParts {
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second);
  const date = new Date(utc);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function shiftDateByMonths(parts: DateParts, months: number): DateParts {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  const originalDay = utc.getUTCDate();
  utc.setUTCMonth(utc.getUTCMonth() + months, 1);
  const endOfMonth = new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth() + 1, 0)).getUTCDate();
  utc.setUTCDate(Math.min(originalDay, endOfMonth));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: utc.getUTCHours(),
    minute: utc.getUTCMinutes(),
    second: utc.getUTCSeconds(),
  };
}

function shiftDateByYears(parts: DateParts, years: number): DateParts {
  const nextYear = parts.year + years;
  const endOfMonth = new Date(Date.UTC(nextYear, parts.month, 0)).getUTCDate();
  return {
    year: nextYear,
    month: parts.month,
    day: Math.min(parts.day, endOfMonth),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function zonedDateToUtc(parts: DateParts, timezone: string): Date {
  let utcMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);

  for (let i = 0; i < 3; i += 1) {
    const observed = datePartsInTimezone(new Date(utcMillis), timezone);
    const wanted = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const got = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const delta = wanted - got;
    if (delta === 0) break;
    utcMillis += delta;
  }

  return new Date(utcMillis);
}

function addDaysInTimezone(date: Date, days: number, timezone: string): Date {
  const parts = datePartsInTimezone(date, timezone);
  return zonedDateToUtc(shiftDateByDays(parts, days), timezone);
}

function addMonthsInTimezone(date: Date, months: number, timezone: string): Date {
  const parts = datePartsInTimezone(date, timezone);
  return zonedDateToUtc(shiftDateByMonths(parts, months), timezone);
}

function addYearsInTimezone(date: Date, years: number, timezone: string): Date {
  const parts = datePartsInTimezone(date, timezone);
  return zonedDateToUtc(shiftDateByYears(parts, years), timezone);
}

function weekdayInTimezone(date: Date, timezone: string): number {
  const parts = datePartsInTimezone(date, timezone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function weekAnchorDateKey(date: Date, timezone: string): string {
  const weekday = weekdayInTimezone(date, timezone);
  const parts = datePartsInTimezone(date, timezone);
  const anchor = shiftDateByDays(
    {
      ...parts,
      hour: 0,
      minute: 0,
      second: 0,
    },
    -weekday,
  );
  return `${anchor.year}-${String(anchor.month).padStart(2, "0")}-${String(anchor.day).padStart(2, "0")}`;
}

function daysBetweenDateKeys(startKey: string, endKey: string): number {
  const [startY, startM, startD] = startKey.split("-").map(Number);
  const [endY, endM, endD] = endKey.split("-").map(Number);
  const startTs = Date.UTC(startY, startM - 1, startD);
  const endTs = Date.UTC(endY, endM - 1, endD);
  return Math.floor((endTs - startTs) / (24 * 60 * 60 * 1000));
}

function resolveAllDaySpanDays(start: Date, end: Date, timezone: string): number {
  const byDateKeys = daysBetweenDateKeys(
    dateKeyInTimezone(start, timezone),
    dateKeyInTimezone(end, timezone),
  );
  if (byDateKeys > 0) return byDateKeys;

  const byDuration = Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(1, byDuration);
}

function weeklyMatch(
  occurrenceStart: Date,
  seriesStart: Date,
  recurrence: RecurrenceConfig,
  timezone: string,
): boolean {
  const byWeekdays = recurrence.byWeekdays ?? [weekdayInTimezone(seriesStart, timezone)];
  const day = weekdayInTimezone(occurrenceStart, timezone);
  if (!byWeekdays.includes(day)) return false;

  const anchorStart = weekAnchorDateKey(seriesStart, timezone);
  const anchorCurrent = weekAnchorDateKey(occurrenceStart, timezone);
  const days = daysBetweenDateKeys(anchorStart, anchorCurrent);
  if (days < 0) return false;
  const weekDiff = Math.floor(days / 7);
  return weekDiff % recurrence.interval === 0;
}

function isBeforeOrEqualDateKey(left: string, right: string): boolean {
  return left.localeCompare(right) <= 0;
}

function shouldIncludeByEndCondition(
  occurrenceStart: Date,
  recurrence: RecurrenceConfig,
  timezone: string,
): boolean {
  const endCondition = recurrence.endCondition;
  if (!endCondition || endCondition.type === "never") return true;
  return isBeforeOrEqualDateKey(dateKeyInTimezone(occurrenceStart, timezone), endCondition.untilDate);
}

function intersectsWindow(start: Date, end: Date, windowStart: Date, windowEnd: Date): boolean {
  return end > windowStart && start < windowEnd;
}

function buildExceptionMap(exceptions: RecurrenceException[]): Map<string, RecurrenceException> {
  return new Map(exceptions.map((item) => [item.occurrenceStart.toISOString(), item]));
}

export function expandCardOccurrences(
  card: Card,
  windowStart: Date,
  windowEnd: Date,
  options?: {
    exceptions?: RecurrenceException[];
  },
): ExpandedOccurrence[] {
  if (!card.scheduledStart || !card.scheduledEnd) return [];
  if (windowEnd <= windowStart) return [];

  const timezone = resolveTimezone(card.scheduleTimezone);
  const reminders = card.reminders ?? [];
  const recurrence = card.recurrence;
  const exceptions = buildExceptionMap(options?.exceptions ?? []);
  const occurrences: ExpandedOccurrence[] = [];
  const allDaySpanDays = card.isAllDay
    ? resolveAllDaySpanDays(card.scheduledStart, card.scheduledEnd, timezone)
    : null;
  const durationMs = Math.max(60_000, card.scheduledEnd.getTime() - card.scheduledStart.getTime());

  const addOccurrence = (baseStart: Date): void => {
    if (!shouldIncludeByEndCondition(baseStart, recurrence ?? { frequency: "daily", interval: 1 }, timezone)) return;
    const exception = exceptions.get(baseStart.toISOString());
    if (exception?.exceptionType === "skip") return;

    const start = exception?.exceptionType === "override_time" && exception.overrideStart
      ? exception.overrideStart
      : baseStart;
    const end = exception?.exceptionType === "override_time" && exception.overrideEnd
      ? exception.overrideEnd
      : allDaySpanDays !== null
        ? addDaysInTimezone(start, allDaySpanDays, timezone)
        : new Date(start.getTime() + durationMs);
    if (!intersectsWindow(start, end, windowStart, windowEnd)) return;

    occurrences.push({
      occurrenceStart: start,
      occurrenceEnd: end,
      reminders: exception?.overrideReminders ?? reminders,
    });
  };

  if (!recurrence) {
    addOccurrence(card.scheduledStart);
    return occurrences.sort((a, b) => a.occurrenceStart.getTime() - b.occurrenceStart.getTime());
  }

  let cursor = card.scheduledStart;
  let generated = 0;

  if (recurrence.frequency === "weekly") {
    const endScan = addDaysInTimezone(windowEnd, 14, timezone);
    while (cursor < endScan && generated < MAX_GENERATED_OCCURRENCES) {
      generated += 1;
      if (cursor >= card.scheduledStart && weeklyMatch(cursor, card.scheduledStart, recurrence, timezone)) {
        addOccurrence(cursor);
      }
      cursor = addDaysInTimezone(cursor, 1, timezone);
    }
  } else {
    while (cursor < windowEnd && generated < MAX_GENERATED_OCCURRENCES) {
      generated += 1;
      addOccurrence(cursor);
      if (recurrence.frequency === "daily") {
        cursor = addDaysInTimezone(cursor, recurrence.interval, timezone);
      } else if (recurrence.frequency === "monthly") {
        cursor = addMonthsInTimezone(cursor, recurrence.interval, timezone);
      } else {
        cursor = addYearsInTimezone(cursor, recurrence.interval, timezone);
      }
    }
  }

  return occurrences.sort((a, b) => a.occurrenceStart.getTime() - b.occurrenceStart.getTime());
}

export function nextOccurrenceAfter(
  card: Card,
  afterOccurrenceStart: Date,
  options?: {
    exceptions?: RecurrenceException[];
  },
): ExpandedOccurrence | null {
  const scanStart = new Date(afterOccurrenceStart.getTime() + 1);
  const scanEnd = addYearsInTimezone(scanStart, 5, resolveTimezone(card.scheduleTimezone));
  const occurrences = expandCardOccurrences(card, scanStart, scanEnd, options);
  const afterTs = afterOccurrenceStart.getTime();
  return occurrences.find((occurrence) => occurrence.occurrenceStart.getTime() > afterTs) ?? null;
}

export function shiftUntilDateByDays(untilDate: string, days: number): string {
  const [year, month, day] = untilDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
