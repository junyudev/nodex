import { parsePageAssignee, parsePageWork } from "./work-graph";
import type {
  PageInput,
  Estimate,
  RecurrenceConfig,
  RecurrenceEndCondition,
  RecurrenceFrequency,
  ReminderConfig,
} from "./types";
import { isPriority } from "./priority";
import { parseDataSourceOptionId } from "./database-identities";
import {
  MAX_PAGE_DESCRIPTION_LENGTH,
  MAX_PAGE_TAG_COUNT,
  MAX_PAGE_TITLE_LENGTH,
} from "./page-limits";

const ESTIMATE_VALUES: Estimate[] = ["xs", "s", "m", "l", "xl"];

const RUN_IN_TARGET_VALUES: Array<NonNullable<PageInput["runInTarget"]>> = [
  "localProject",
  "newWorktree",
  "cloud",
];

const RECURRENCE_FREQUENCY_VALUES: RecurrenceFrequency[] = ["daily", "weekly", "monthly", "yearly"];

const MAX_REMINDER_OFFSET_MINUTES = 365 * 24 * 60;

export function assertValidPageInput(input: Partial<PageInput>, mode: "create" | "update"): void {
  if (mode === "create") {
    if (typeof input.title !== "string") {
      throw new Error("Page title is required");
    }
    if (input.title.trim().length === 0) {
      throw new Error("Page title cannot be empty");
    }
  }

  assertOptionalString("title", input.title, MAX_PAGE_TITLE_LENGTH);
  if (typeof input.title === "string" && input.title.trim().length === 0) {
    throw new Error("Page title cannot be empty");
  }

  assertOptionalString("description", input.description, MAX_PAGE_DESCRIPTION_LENGTH);
  assertOptionalPriority(input.priority);
  assertOptionalEstimate(input.estimate);
  assertOptionalTags(input.tags);
  assertOptionalDueDate(input.dueDate);
  assertOptionalDatetime("scheduledStart", input.scheduledStart);
  assertOptionalDatetime("scheduledEnd", input.scheduledEnd);
  assertOptionalBoolean("isAllDay", input.isAllDay);
  assertScheduledRange(input.scheduledStart, input.scheduledEnd);
  assertAllDaySchedulePair(input.isAllDay, input.scheduledStart, input.scheduledEnd);
  assertOptionalRecurrence(input.recurrence);
  assertOptionalReminders(input.reminders);
  assertOptionalScheduleTimezone(input.scheduleTimezone);
  if (input.assignee !== undefined) parsePageAssignee(input.assignee);
  if (input.pageWork !== undefined && !parsePageWork(input.pageWork))
    throw new TypeError("Page work requires an Owner");
  assertOptionalRunInTarget(input.runInTarget);
  assertOptionalRunInLocalPath(input.runInLocalPath);
  assertOptionalRunInBaseBranch(input.runInBaseBranch);
  assertOptionalRunInWorktreePath(input.runInWorktreePath);
  assertOptionalRunInEnvironmentPath(input.runInEnvironmentPath);
}

function assertOptionalString(fieldName: string, value: unknown, maxLength: number): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${fieldName} value`);
  }
  if (value.length <= maxLength) return;

  throw new Error(`${fieldName} exceeds ${maxLength} characters`);
}

function assertOptionalBoolean(fieldName: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "boolean") return;
  throw new Error(`Invalid ${fieldName} value`);
}

function assertOptionalPriority(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new Error("Invalid priority value");
  }
  if (isPriority(value)) return;

  throw new Error(`Invalid priority "${value}"`);
}

function assertOptionalEstimate(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new Error("Invalid estimate value");
  }
  if (ESTIMATE_VALUES.includes(value as Estimate)) return;

  throw new Error(`Invalid estimate "${value}"`);
}

function assertOptionalTags(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error("Invalid tags value");
  }
  if (value.length > MAX_PAGE_TAG_COUNT) {
    throw new Error(`tags exceeds ${MAX_PAGE_TAG_COUNT} items`);
  }

  const optionIds = new Set<string>();
  for (const optionId of value) {
    let parsed: string;
    try {
      parsed = parseDataSourceOptionId({ propertyId: "tags", value: optionId });
    } catch {
      throw new Error("Invalid tag option identity");
    }
    if (optionIds.has(parsed)) {
      throw new Error("Duplicate tag option identities are not allowed");
    }
    optionIds.add(parsed);
  }
}

function assertOptionalDueDate(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!(value instanceof Date)) {
    throw new Error("Invalid dueDate value");
  }
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Invalid dueDate value");
  }
}

function assertOptionalDatetime(fieldName: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (!(value instanceof Date)) {
    throw new Error(`Invalid ${fieldName} value`);
  }
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`Invalid ${fieldName} value`);
  }
}

function assertScheduledRange(start: unknown, end: unknown): void {
  if (!(start instanceof Date) || !(end instanceof Date)) return;
  if (end.getTime() <= start.getTime()) {
    throw new Error("scheduledEnd must be after scheduledStart");
  }
}

function assertAllDaySchedulePair(isAllDay: unknown, start: unknown, end: unknown): void {
  if (isAllDay !== true) return;
  if (start instanceof Date && end instanceof Date) return;
  throw new Error("isAllDay requires scheduledStart and scheduledEnd");
}

function assertOptionalRecurrence(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isRecurrenceConfig(value)) {
    throw new Error("Invalid recurrence value");
  }
}

function assertOptionalReminders(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error("Invalid reminders value");
  }

  const seen = new Set<number>();
  for (const reminder of value) {
    if (!isReminderConfig(reminder)) {
      throw new Error("Invalid reminders value");
    }
    if (seen.has(reminder.offsetMinutes)) {
      throw new Error("Duplicate reminder offsets are not allowed");
    }
    if (reminder.offsetMinutes > MAX_REMINDER_OFFSET_MINUTES) {
      throw new Error(`reminder offset exceeds ${MAX_REMINDER_OFFSET_MINUTES} minutes`);
    }
    seen.add(reminder.offsetMinutes);
  }
}

function assertOptionalScheduleTimezone(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid scheduleTimezone value");
  }

  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
  } catch {
    throw new Error(`Invalid scheduleTimezone "${value}"`);
  }
}

function assertOptionalRunInTarget(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new Error("Invalid runInTarget value");
  }
  if (RUN_IN_TARGET_VALUES.includes(value as NonNullable<PageInput["runInTarget"]>)) return;
  throw new Error(`Invalid runInTarget "${value}"`);
}

function assertOptionalRunInLocalPath(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new Error("Invalid runInLocalPath value");
  }
}

function assertOptionalRunInBaseBranch(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new Error("Invalid runInBaseBranch value");
  }

  const normalized = value.trim();
  if (!normalized) return;
  if (normalized.startsWith("-")) {
    throw new Error("Invalid runInBaseBranch value");
  }
  if (/[~^:?*\[\]\\\s]/.test(normalized)) {
    throw new Error("Invalid runInBaseBranch value");
  }
}

function assertOptionalRunInWorktreePath(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new Error("Invalid runInWorktreePath value");
  }
}

function assertOptionalRunInEnvironmentPath(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new Error("Invalid runInEnvironmentPath value");
  }
}

function isReminderConfig(value: unknown): value is ReminderConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { offsetMinutes?: unknown };
  return Number.isInteger(candidate.offsetMinutes) && (candidate.offsetMinutes as number) >= 0;
}

function isRecurrenceConfig(value: unknown): value is RecurrenceConfig {
  if (typeof value !== "object" || value === null) return false;
  const recurrence = value as {
    frequency?: unknown;
    interval?: unknown;
    byWeekdays?: unknown;
    endCondition?: unknown;
  };

  if (typeof recurrence.frequency !== "string") return false;
  if (!RECURRENCE_FREQUENCY_VALUES.includes(recurrence.frequency as RecurrenceFrequency))
    return false;
  if (!Number.isInteger(recurrence.interval) || (recurrence.interval as number) < 1) return false;

  if (recurrence.byWeekdays !== undefined) {
    if (!Array.isArray(recurrence.byWeekdays)) return false;
    if (recurrence.byWeekdays.length === 0) return false;
    const unique = new Set<number>();
    for (const day of recurrence.byWeekdays) {
      if (!Number.isInteger(day) || (day as number) < 0 || (day as number) > 6) return false;
      unique.add(day as number);
    }
    if (unique.size !== recurrence.byWeekdays.length) return false;
  }

  if (recurrence.frequency === "weekly" && recurrence.byWeekdays === undefined) {
    return false;
  }

  if (recurrence.endCondition !== undefined && !isRecurrenceEndCondition(recurrence.endCondition)) {
    return false;
  }

  return true;
}

function isRecurrenceEndCondition(value: unknown): value is RecurrenceEndCondition {
  if (typeof value !== "object" || value === null) return false;
  const condition = value as { type?: unknown; untilDate?: unknown };
  if (condition.type === "never") return true;
  if (condition.type !== "untilDate") return false;
  if (typeof condition.untilDate !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(condition.untilDate);
}
