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

export const MORNING_HOUR = 9;
/** A morning snooze never lands sooner than this; "tomorrow" at 8 AM would be an hour away. */
const MIN_MORNING_LEAD_MS = 3 * 60 * 60 * 1000;
const MONDAY = 1;

export function addMinutesRoundedUp(now: Date, minutes: number): Date {
  // Round elapsed time so a repeated local hour keeps its original offset.
  const target = now.getTime() + minutes * 60_000;
  return new Date(Math.ceil(target / 60_000) * 60_000);
}

function atLocalMorning(day: Date): Date {
  const next = new Date(day);
  next.setHours(MORNING_HOUR, 0, 0, 0);
  return next;
}

/** The next 9:00 AM at least three hours away: this morning in the small hours, else tomorrow. */
export function nextMorning(now: Date): Date {
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

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Calendar days from `now`'s day to `date`'s, in local time: 0 today, 1 tomorrow, -1 yesterday. */
export function localDayDistance(date: Date, now: Date): number {
  return Math.round(
    (startOfLocalDay(date).getTime() - startOfLocalDay(now).getTime()) / 86_400_000,
  );
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

/**
 * How far off a snoozed chat's return is. One back by the end of tomorrow is `soon`: its person
 * meets it again within a day. Anything after that is `later`, and steps back until it nears.
 */
export type SnoozeHorizon = "soon" | "later";

export function resolveSnoozeHorizon(snoozedUntil: string, now: Date): SnoozeHorizon {
  const at = new Date(snoozedUntil);
  return Number.isFinite(at.getTime()) && localDayDistance(at, now) > 1 ? "later" : "soon";
}

/** A return this close names its time even past midnight, as a late three-hour snooze does. */
const WAKE_CLOCK_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * When a snoozed chat returns, short enough for a row's trailing edge: its time within the day or
 * the next few hours, then "Tomorrow", a weekday within the week, and a date beyond it.
 */
export function formatSnoozeWakeLabel(
  snoozedUntil: string,
  now: Date,
  locale?: string,
): string | null {
  const at = new Date(snoozedUntil);
  if (!Number.isFinite(at.getTime())) return null;
  const days = localDayDistance(at, now);
  if (days <= 0 || at.getTime() - now.getTime() <= WAKE_CLOCK_WINDOW_MS)
    return formatTime(at, locale);
  if (days === 1)
    return getIntl().formatMessage({
      id: "lib.chatSnooze.tomorrowName",
      defaultMessage: "Tomorrow",
    });
  const resolvedLocale = locale ?? getIntl().locale;
  if (days < 7) return new Intl.DateTimeFormat(resolvedLocale, { weekday: "short" }).format(at);
  return new Intl.DateTimeFormat(resolvedLocale, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
  }).format(at);
}

/** What the Snoozed lane says about its chats at one moment. */
export interface SnoozedLanePresentation {
  /** When each chat returns, as its row says it, by chat id. */
  readonly wakeLabels: ReadonlyMap<string, string>;
  /** The chats returning after tomorrow; their rows step back. */
  readonly later: ReadonlySet<string>;
  /**
   * Where the fold begins: after the last chat returning soon, so a held lane that lists a later
   * chat above a sooner one never folds the sooner one. Null when the fold would hide nothing.
   */
  readonly fold: {
    readonly from: number;
    /** The chats it hides; the chat on screen always shows. */
    readonly count: number;
    /** When the hidden chats return, from the earliest to the latest: "Mon – Dec 8". */
    readonly range: string | null;
  } | null;
  /** The next moment any row reads differently: the day turns, or a return comes within hours. */
  readonly nextChangeAt: number | null;
}

/** Reads the Snoozed lane in the order it shows at `now`; `shownId` is the chat on screen. */
export function presentSnoozedLane(
  chats: readonly { readonly id: string; readonly snoozedUntil: string | null }[],
  now: Date,
  locale?: string,
  shownId: string | null = null,
): SnoozedLanePresentation {
  const wakeLabels = new Map<string, string>();
  const later = new Set<string>();
  let lastSoon = -1;
  const tomorrow = startOfLocalDay(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  let nextChangeAt = chats.length > 0 ? tomorrow.getTime() : null;
  chats.forEach((chat, index) => {
    if (!chat.snoozedUntil || resolveSnoozeHorizon(chat.snoozedUntil, now) === "soon")
      lastSoon = index;
    else later.add(chat.id);
    if (!chat.snoozedUntil) return;
    const label = formatSnoozeWakeLabel(chat.snoozedUntil, now, locale);
    if (label) wakeLabels.set(chat.id, label);
    const clockFrom = Date.parse(chat.snoozedUntil) - WAKE_CLOCK_WINDOW_MS;
    if (nextChangeAt !== null && clockFrom > now.getTime() && clockFrom < nextChangeAt)
      nextChangeAt = clockFrom;
  });
  const from = lastSoon + 1;
  const hidden = chats
    .slice(from)
    .flatMap((chat) =>
      chat.id !== shownId && chat.snoozedUntil
        ? [{ id: chat.id, at: Date.parse(chat.snoozedUntil) }]
        : [],
    )
    .toSorted((left, right) => left.at - right.at);
  const first = hidden[0] ? wakeLabels.get(hidden[0].id) : undefined;
  const last = hidden.at(-1) ? wakeLabels.get(hidden.at(-1)!.id) : undefined;
  const range =
    first === undefined || last === undefined
      ? null
      : first === last
        ? first
        : getIntl().formatMessage(
            { id: "lib.chatSnooze.wakeRange", defaultMessage: "{first} – {last}" },
            { first, last },
          );
  return {
    wakeLabels,
    later,
    fold: hidden.length > 0 ? { from, count: hidden.length, range } : null,
    nextChangeAt,
  };
}
