/**
 * A chat reminder makes a chat unread again at a chosen time. The person picks one of a few
 * presets; every surface that offers them (chat menus, the command palette) reads this list so
 * the choices and their wording stay identical.
 */

export type ChatReminderPresetId = "in-1-hour" | "in-3-hours" | "next-morning" | "next-week";

export interface ChatReminderPreset {
  readonly id: ChatReminderPresetId;
  /** Names the preset and, for a fixed time of day, the time: "Tomorrow, 9:00 AM". */
  readonly label: string;
  /** The instant the chat becomes unread again, as an ISO 8601 UTC string. */
  readonly remindAt: string;
}

const MORNING_HOUR = 9;
/** A morning reminder never lands sooner than this; "tomorrow" at 8 AM would be an hour away. */
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
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
}

function formatWeekdayTime(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export const CHAT_REMINDER_PRESET_IDS: readonly ChatReminderPresetId[] = [
  "in-1-hour",
  "in-3-hours",
  "next-morning",
  "next-week",
];

function presetDate(id: ChatReminderPresetId, now: Date): Date {
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

/** The instant a preset chosen at `now` reminds at, as an ISO 8601 UTC string. */
export function chatReminderPresetTime(id: ChatReminderPresetId, now: Date): string {
  return presetDate(id, now).toISOString();
}

function presetLabel(id: ChatReminderPresetId, at: Date, now: Date, locale?: string): string {
  switch (id) {
    case "in-1-hour":
      return "In 1 hour";
    case "in-3-hours":
      return "In 3 hours";
    case "next-morning":
      return `${isSameLocalDay(at, now) ? "This morning" : "Tomorrow"}, ${formatTime(at, locale)}`;
    case "next-week":
      return `Next week, ${formatWeekdayTime(at, locale)}`;
  }
}

/** The presets offered at `now`, earliest first; a preset landing on an earlier one's time is dropped. */
export function chatReminderPresets(now: Date, locale?: string): readonly ChatReminderPreset[] {
  const seen = new Set<number>();
  return CHAT_REMINDER_PRESET_IDS.flatMap((id) => {
    const at = presetDate(id, now);
    if (seen.has(at.getTime())) return [];
    seen.add(at.getTime());
    return [{ id, label: presetLabel(id, at, now, locale), remindAt: at.toISOString() }];
  });
}

/** When a pending reminder fires, relative to `now`: "today at 4:12 PM", "tomorrow at 9:00 AM". */
export function formatChatReminderTime(
  remindAt: string,
  now: Date,
  locale?: string,
): string | null {
  const at = new Date(remindAt);
  if (!Number.isFinite(at.getTime())) return null;
  const time = formatTime(at, locale);
  if (isSameLocalDay(at, now)) return `today at ${time}`;
  if (isNextLocalDay(at, now)) return `tomorrow at ${time}`;
  const date = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
  }).format(at);
  return `${date} at ${time}`;
}

/** Confirms a reminder the person just set: "Reminder set for tomorrow at 9:00 AM". */
export function formatChatReminderConfirmation(
  remindAt: string,
  now: Date,
  locale?: string,
): string {
  const time = formatChatReminderTime(remindAt, now, locale);
  return time ? `Reminder set for ${time}` : "Reminder set";
}

/**
 * Names a pending reminder's time without reference to now, for text that may outlive the moment
 * it was rendered, such as a row's accessible description: "Reminder for Tue, Nov 3, 9:00 AM".
 */
export function describeChatReminderAbsolute(remindAt: string, locale?: string): string {
  const at = new Date(remindAt);
  if (!Number.isFinite(at.getTime())) return "Reminder set";
  const when = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  return `Reminder for ${when}`;
}

/** Describes a pending reminder relative to `now`, for menus and hover cards. */
export function describeChatReminder(remindAt: string, now: Date, locale?: string): string {
  const at = new Date(remindAt);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) return "Reminder due";
  return `Reminds you ${formatChatReminderTime(remindAt, now, locale)}`;
}
