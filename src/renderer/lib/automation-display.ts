import { getIntl } from "@/lib/i18n";
import { parseAutomationRruleFields } from "./automation-rrule";

const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR"];

export function formatAutomationRruleSummary(rrule: string | null): string | null {
  if (!rrule) return null;

  const fields = parseAutomationRruleFields(rrule);
  const frequency = fields.get("FREQ");
  const interval = Number.parseInt(fields.get("INTERVAL") ?? "1", 10);
  const normalizedInterval = Number.isFinite(interval) && interval > 1 ? interval : 1;

  if (frequency === "DAILY") {
    return normalizedInterval === 1
      ? getIntl().formatMessage({ id: "lib.automationDisplay.daily", defaultMessage: "Daily" })
      : getIntl().formatMessage(
          { id: "lib.automationDisplay.everyDays", defaultMessage: "Every {interval} days" },
          { interval: normalizedInterval },
        );
  }

  if (frequency === "WEEKLY") {
    const byDay = fields.get("BYDAY")?.split(",").filter(Boolean) ?? [];
    const isWeekday =
      byDay.length === WEEKDAY_CODES.length && WEEKDAY_CODES.every((day) => byDay.includes(day));
    if (isWeekday && normalizedInterval === 1)
      return getIntl().formatMessage({
        id: "lib.automationDisplay.weekday",
        defaultMessage: "Every weekday",
      });
    return normalizedInterval === 1
      ? getIntl().formatMessage({ id: "lib.automationDisplay.weekly", defaultMessage: "Weekly" })
      : getIntl().formatMessage(
          { id: "lib.automationDisplay.everyWeeks", defaultMessage: "Every {interval} weeks" },
          { interval: normalizedInterval },
        );
  }

  if (frequency === "MONTHLY") {
    return normalizedInterval === 1
      ? getIntl().formatMessage({ id: "lib.automationDisplay.monthly", defaultMessage: "Monthly" })
      : getIntl().formatMessage(
          { id: "lib.automationDisplay.everyMonths", defaultMessage: "Every {interval} months" },
          { interval: normalizedInterval },
        );
  }

  if (frequency === "YEARLY") {
    return normalizedInterval === 1
      ? getIntl().formatMessage({ id: "lib.automationDisplay.yearly", defaultMessage: "Yearly" })
      : getIntl().formatMessage(
          { id: "lib.automationDisplay.everyYears", defaultMessage: "Every {interval} years" },
          { interval: normalizedInterval },
        );
  }

  return getIntl().formatMessage({
    id: "lib.automationDisplay.custom",
    defaultMessage: "Custom schedule",
  });
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat(getIntl().locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatAutomationNextRunLabel(nextRunAt: number | null, now = new Date()): string {
  if (nextRunAt === null || !Number.isFinite(nextRunAt))
    return getIntl().formatMessage({
      id: "lib.automationDisplay.noUpcomingRun",
      defaultMessage: "No upcoming run",
    });

  const nextRun = new Date(nextRunAt);
  if (isSameLocalDate(nextRun, now))
    return getIntl().formatMessage(
      { id: "lib.automationDisplay.today", defaultMessage: "today at {time}" },
      { time: formatTime(nextRun) },
    );
  if (isSameLocalDate(nextRun, addLocalDays(now, 1)))
    return getIntl().formatMessage(
      { id: "lib.automationDisplay.tomorrow", defaultMessage: "tomorrow at {time}" },
      { time: formatTime(nextRun) },
    );

  return new Intl.DateTimeFormat(getIntl().locale, {
    month: "short",
    day: "numeric",
    year: nextRun.getFullYear() === now.getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(nextRun);
}
