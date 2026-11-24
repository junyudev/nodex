import { getIntl } from "@/lib/i18n";
/**
 * A chat snooze makes a chat unread again at a chosen time. The person picks one of a few
 * presets; every surface that offers them (chat menus, the command palette) reads this list so
 * the choices and their wording stay identical.
 */

export type ChatSnoozePresetId = "in-1-hour" | "in-3-hours" | "next-morning" | "next-week";

export interface ChatSnoozePreset {
  readonly id: ChatSnoozePresetId;
  /** Names the preset and, for a fixed time of day, the time: "Tomorrow, 9:00 AM". */
  readonly label: string;
  /** The preset's name alone, for a menu that shows the time beside it: "Tomorrow". */
  readonly name: string;
  /** When the chat comes back, as that menu shows it: "9:00 AM", "Mon 9:00 AM". */
  readonly when: string;
  /** The instant the chat becomes unread again, as an ISO 8601 UTC string. */
  readonly snoozedUntil: string;
}

const MORNING_HOUR = 9;
/** A morning snooze never lands sooner than this; "tomorrow" at 8 AM would be an hour away. */
const MIN_MORNING_LEAD_MS = 3 * 60 * 60 * 1000;
const MONDAY = 1;

function addMinutesRoundedUp(now: Date, minutes: number): Date {
  const next = new Date(now.getTime() + minutes * 60_000);
  if (next.getSeconds() > 0 || next.getMilliseconds() > 0) {
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);
  }
  return next;
}

function atLocalMorning(day: Date): Date {
  const next = new Date(day);
  next.setHours(MORNING_HOUR, 0, 0, 0);
  return next;
}

/** The next 9:00 AM at least three hours away: this morning in the small hours, else tomorrow. */
function nextMorning(now: Date): Date {
  const today = atLocalMorning(now);
  if (today.getTime() - now.getTime() >= MIN_MORNING_LEAD_MS) return today;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return atLocalMorning(tomorrow);
}

/** Monday 9:00 AM of the following week. */
function nextWeekMorning(now: Date): Date {
  const daysUntilMonday = (MONDAY - now.getDay() + 7) % 7 || 7;
  const monday = new Date(now);
  monday.setDate(monday.getDate() + daysUntilMonday);
  return atLocalMorning(monday);
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isNextLocalDay(day: Date, now: Date): boolean {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return isSameLocalDay(day, tomorrow);
}

function formatTime(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale ?? getIntl().locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatWeekdayTime(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale ?? getIntl().locale, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export const CHAT_SNOOZE_PRESET_IDS: readonly ChatSnoozePresetId[] = [
  "in-1-hour",
  "in-3-hours",
  "next-morning",
  "next-week",
];

function presetDate(id: ChatSnoozePresetId, now: Date): Date {
  switch (id) {
    case "in-1-hour":
      return addMinutesRoundedUp(now, 60);
    case "in-3-hours":
      return addMinutesRoundedUp(now, 180);
    case "next-morning":
      return nextMorning(now);
    case "next-week":
      return nextWeekMorning(now);
  }
}

/** The wake time of a preset chosen at `now`, as an ISO 8601 UTC string. */
export function chatSnoozePresetTime(id: ChatSnoozePresetId, now: Date): string {
  return presetDate(id, now).toISOString();
}

function presetLabel(id: ChatSnoozePresetId, at: Date, now: Date, locale?: string): string {
  switch (id) {
    case "in-1-hour":
      return getIntl().formatMessage({
        id: "lib.chatSnooze.inOneHour",
        defaultMessage: "In 1 hour",
      });
    case "in-3-hours":
      return getIntl().formatMessage({
        id: "lib.chatSnooze.inThreeHours",
        defaultMessage: "In 3 hours",
      });
    case "next-morning":
      return isSameLocalDay(at, now)
        ? getIntl().formatMessage(
            { id: "lib.chatSnooze.morningPreset", defaultMessage: "This morning, {time}" },
            { time: formatTime(at, locale) },
          )
        : getIntl().formatMessage(
            { id: "lib.chatSnooze.tomorrowPreset", defaultMessage: "Tomorrow, {time}" },
            { time: formatTime(at, locale) },
          );
    case "next-week":
      return getIntl().formatMessage(
        { id: "lib.chatSnooze.nextWeek", defaultMessage: "Next week, {time}" },
        { time: formatWeekdayTime(at, locale) },
      );
  }
}

function presetName(id: ChatSnoozePresetId, at: Date, now: Date): string {
  switch (id) {
    case "in-1-hour":
      return getIntl().formatMessage({
        id: "lib.chatSnooze.inOneHour",
        defaultMessage: "In 1 hour",
      });
    case "in-3-hours":
      return getIntl().formatMessage({
        id: "lib.chatSnooze.inThreeHours",
        defaultMessage: "In 3 hours",
      });
    case "next-morning":
      return isSameLocalDay(at, now)
        ? getIntl().formatMessage({
            id: "lib.chatSnooze.thisMorningName",
            defaultMessage: "This morning",
          })
        : getIntl().formatMessage({
            id: "lib.chatSnooze.tomorrowName",
            defaultMessage: "Tomorrow",
          });
    case "next-week":
      return getIntl().formatMessage({
        id: "lib.chatSnooze.nextWeekName",
        defaultMessage: "Next week",
      });
  }
}

/** The presets offered at `now`, earliest first; a preset landing on an earlier one's time is dropped. */
export function chatSnoozePresets(now: Date, locale?: string): readonly ChatSnoozePreset[] {
  const seen = new Set<number>();
  return CHAT_SNOOZE_PRESET_IDS.flatMap((id) => {
    const at = presetDate(id, now);
    if (seen.has(at.getTime())) return [];
    seen.add(at.getTime());
    return [
      {
        id,
        label: presetLabel(id, at, now, locale),
        name: presetName(id, at, now),
        when: id === "next-week" ? formatWeekdayTime(at, locale) : formatTime(at, locale),
        snoozedUntil: at.toISOString(),
      },
    ];
  });
}

/** When a pending snooze fires, relative to `now`: "today at 4:12 PM", "tomorrow at 9:00 AM". */
export function formatChatSnoozeTime(
  snoozedUntil: string,
  now: Date,
  locale?: string,
): string | null {
  const at = new Date(snoozedUntil);
  if (!Number.isFinite(at.getTime())) return null;
  const time = formatTime(at, locale);
  if (isSameLocalDay(at, now))
    return getIntl().formatMessage(
      { id: "lib.chatSnooze.today", defaultMessage: "today at {time}" },
      { time },
    );
  if (isNextLocalDay(at, now))
    return getIntl().formatMessage(
      { id: "lib.chatSnooze.tomorrow", defaultMessage: "tomorrow at {time}" },
      { time },
    );
  const date = new Intl.DateTimeFormat(locale ?? getIntl().locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
  }).format(at);
  return getIntl().formatMessage(
    { id: "lib.chatSnooze.dateAtTime", defaultMessage: "{date} at {time}" },
    { date, time },
  );
}

/** Confirms a snooze the person just set: "Snoozed until tomorrow at 9:00 AM". */
export function formatChatSnoozeConfirmation(
  snoozedUntil: string,
  now: Date,
  locale?: string,
): string {
  const time = formatChatSnoozeTime(snoozedUntil, now, locale);
  return time
    ? getIntl().formatMessage(
        { id: "lib.chatSnooze.setFor", defaultMessage: "Snoozed until {time}" },
        { time },
      )
    : getIntl().formatMessage({ id: "lib.chatSnooze.set", defaultMessage: "Snoozed" });
}

/**
 * Names a pending snooze's time without reference to now, for text that may outlive the moment
 * it was rendered, such as a row's accessible description: "Snoozed until Tue, Nov 3, 9:00 AM".
 */
export function describeChatSnoozeAbsolute(snoozedUntil: string, locale?: string): string {
  const at = new Date(snoozedUntil);
  if (!Number.isFinite(at.getTime()))
    return getIntl().formatMessage({ id: "lib.chatSnooze.set", defaultMessage: "Snoozed" });
  const when = new Intl.DateTimeFormat(locale ?? getIntl().locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  return getIntl().formatMessage(
    { id: "lib.chatSnooze.absoluteTime", defaultMessage: "Snoozed until {when}" },
    { when },
  );
}

/** Describes a pending snooze relative to `now`, for menus and hover cards. */
export function describeChatSnooze(snoozedUntil: string, now: Date, locale?: string): string {
  const at = new Date(snoozedUntil);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime())
    return getIntl().formatMessage({ id: "lib.chatSnooze.due", defaultMessage: "Snooze ended" });
  return getIntl().formatMessage(
    { id: "lib.chatSnooze.relativeTime", defaultMessage: "Snoozed until {time}" },
    { time: formatChatSnoozeTime(snoozedUntil, now, locale) },
  );
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A local date and time as a `datetime-local` field holds it: "2026-11-05T09:00". */
function toLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Where a custom snooze starts: the next morning, the time a person most often picks. */
export function defaultCustomSnoozeInput(now: Date): string {
  return toLocalInput(nextMorning(now));
}

/** The earliest a custom snooze may be set: the next whole minute. */
export function minimumCustomSnoozeInput(now: Date): string {
  return toLocalInput(addMinutesRoundedUp(now, 1));
}

/**
 * A custom snooze time from a `datetime-local` value, read in the person's own time zone, as an
 * ISO 8601 UTC string. Null when the field is empty, unreadable or not in the future.
 */
export function parseCustomSnoozeInput(value: string, now: Date): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const at = new Date(year!, month! - 1, day!, hour!, minute!);
  if (at.getMonth() !== month! - 1 || at.getDate() !== day!) return null;
  return at.getTime() > now.getTime() ? at.toISOString() : null;
}
