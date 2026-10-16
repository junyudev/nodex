import type { CodexScheduledAutomation } from "./types";
import { parseCodexScheduledAutomationRruleFields } from "./codex-scheduled-automation-rrule";

const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR"];

export function formatCodexScheduledAutomationRruleSummary(rrule: string | null): string | null {
  if (!rrule) return null;

  const fields = parseCodexScheduledAutomationRruleFields(rrule);
  const frequency = fields.get("FREQ");
  const interval = Number.parseInt(fields.get("INTERVAL") ?? "1", 10);
  const normalizedInterval = Number.isFinite(interval) && interval > 1 ? interval : 1;

  if (frequency === "DAILY") {
    return normalizedInterval === 1 ? "Daily" : `Every ${normalizedInterval} days`;
  }

  if (frequency === "WEEKLY") {
    const byDay = fields.get("BYDAY")?.split(",").filter(Boolean) ?? [];
    const isWeekday =
      byDay.length === WEEKDAY_CODES.length && WEEKDAY_CODES.every((day) => byDay.includes(day));
    if (isWeekday && normalizedInterval === 1) return "Every weekday";
    return normalizedInterval === 1 ? "Weekly" : `Every ${normalizedInterval} weeks`;
  }

  if (frequency === "MONTHLY") {
    return normalizedInterval === 1 ? "Monthly" : `Every ${normalizedInterval} months`;
  }

  if (frequency === "YEARLY") {
    return normalizedInterval === 1 ? "Yearly" : `Every ${normalizedInterval} years`;
  }

  return "Custom schedule";
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
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatCodexScheduledAutomationNextRunLabel(
  nextRunAt: number | null,
  now = new Date(),
): string {
  if (nextRunAt === null || !Number.isFinite(nextRunAt)) return "No upcoming run";

  const nextRun = new Date(nextRunAt);
  if (isSameLocalDate(nextRun, now)) return `today at ${formatTime(nextRun)}`;
  if (isSameLocalDate(nextRun, addLocalDays(now, 1))) return `tomorrow at ${formatTime(nextRun)}`;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: nextRun.getFullYear() === now.getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(nextRun);
}
