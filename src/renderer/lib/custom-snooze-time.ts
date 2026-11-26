import { casual as english, type Chrono, type ParsedResult } from "chrono-node/en";
import { casual as chinese } from "chrono-node/zh";
import { addMinutesRoundedUp, MORNING_HOUR, nextMorning } from "./chat-snooze";

export interface SnoozeDraft {
  /** The local calendar day, at local midnight. */
  readonly day: Date;
  /** Minutes after local midnight, 0..1439. */
  readonly minutes: number;
}

export const SNOOZE_SLOT_STEP_MINUTES = 30;

const MINUTES_PER_HOUR = 60;
const NOON_MINUTES = 12 * MINUTES_PER_HOUR;
const SLOT_MINUTES = Array.from(
  { length: (24 * MINUTES_PER_HOUR) / SNOOZE_SLOT_STEP_MINUTES },
  (_, index) => index * SNOOZE_SLOT_STEP_MINUTES,
);

function localMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localMinutes(date: Date): number {
  return date.getHours() * MINUTES_PER_HOUR + date.getMinutes();
}

function draftFromInstant(instant: Date): SnoozeDraft {
  return { day: localMidnight(instant), minutes: localMinutes(instant) };
}

/** The instant a draft names, using the platform's local time zone. */
export function snoozeDraftInstant(draft: SnoozeDraft): Date {
  const { day, minutes } = draft;
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Math.floor(minutes / MINUTES_PER_HOUR),
    minutes % MINUTES_PER_HOUR,
  );
}

export function earliestSnoozeInstant(now: Date): Date {
  return addMinutesRoundedUp(now, 1);
}

export function initialSnoozeDraft(now: Date): SnoozeDraft {
  return draftFromInstant(nextMorning(now));
}

/** Keep the chosen time when possible and otherwise snap to the first available slot. */
export function snoozeDraftOnDay(day: Date, minutes: number, now: Date): SnoozeDraft {
  const earliest = earliestSnoozeInstant(now);
  const earliestDraft = draftFromInstant(earliest);
  const selectedDay = localMidnight(day);
  const draft = { day: selectedDay < earliestDraft.day ? earliestDraft.day : selectedDay, minutes };
  if (snoozeDraftInstant(draft) >= earliest) return draft;

  const firstSlot = SLOT_MINUTES.find(
    (slot) =>
      slot >= earliestDraft.minutes &&
      snoozeDraftInstant({ day: draft.day, minutes: slot }) >= earliest,
  );
  return firstSlot === undefined ? earliestDraft : { day: draft.day, minutes: firstSlot };
}

export interface SnoozeTimeSlot {
  readonly minutes: number;
  readonly label: string;
  readonly disabled: boolean;
}

export function snoozeTimeSlots(
  draft: SnoozeDraft,
  now: Date,
  locale: string,
): readonly SnoozeTimeSlot[] {
  const earliest = earliestSnoozeInstant(now);
  const format = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
  const slots =
    draft.minutes % SNOOZE_SLOT_STEP_MINUTES === 0
      ? SLOT_MINUTES
      : [...SLOT_MINUTES, draft.minutes].sort((a, b) => a - b);
  return slots.map((minutes) => {
    const instant = snoozeDraftInstant({ day: draft.day, minutes });
    return { minutes, label: format.format(instant), disabled: instant < earliest };
  });
}

export type SnoozePhraseResult =
  | { readonly kind: "empty" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "time"; readonly draft: SnoozeDraft };

function parseWholePhrase(
  parser: Chrono,
  phrase: string,
  now: Date,
): ParsedResult["start"] | undefined {
  const [result, ...others] = parser.parse(phrase, now, { forwardDate: true });
  if (others.length > 0 || result?.index !== 0 || result.text !== phrase) return undefined;
  return result.start;
}

function parseLocalizedPhrase(
  phrase: string,
  now: Date,
  locale: string,
): ParsedResult["start"] | undefined {
  return (
    (locale.toLowerCase().startsWith("zh") ? parseWholePhrase(chinese, phrase, now) : undefined) ??
    parseWholePhrase(english, phrase, now)
  );
}

const RELATIVE_PROBE_MS = 60_000;

/**
 * A phrase counted from now, such as "两小时后", moves with the moment it is read; a clock time
 * such as "at 5" stays put. Only a clock time is read as the afternoon.
 */
function isRelativeToNow(
  phrase: string,
  start: ParsedResult["start"],
  now: Date,
  locale: string,
): boolean {
  const later = parseLocalizedPhrase(phrase, new Date(now.getTime() + RELATIVE_PROBE_MS), locale);
  return later?.date().getTime() === start.date().getTime() + RELATIVE_PROBE_MS;
}

export function parseSnoozePhrase(
  text: string,
  now: Date,
  locale: string,
  fallbackMinutes: number,
): SnoozePhraseResult {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };

  const phrase = trimmed.replace(/[.。]$/u, "").trimEnd();
  const start = parseLocalizedPhrase(phrase, now, locale);
  if (!start) return { kind: "unreadable" };

  const year = start.get("year");
  const month = start.get("month");
  const date = start.get("day");
  if (year === null || month === null || date === null) return { kind: "unreadable" };

  const day = new Date(year, month - 1, date);
  const hour = start.get("hour") ?? 12;
  const minutes = hour * MINUTES_PER_HOUR + (start.get("minute") ?? 0);

  if (start.isCertain("hour")) {
    const assumePm =
      !start.isCertain("meridiem") &&
      hour >= 1 &&
      hour <= 6 &&
      !isRelativeToNow(phrase, start, now, locale);
    if (!assumePm) return { kind: "time", draft: { day, minutes } };

    const pmMinutes = minutes + NOON_MINUTES;
    if (start.isCertain("day") || start.isCertain("weekday")) {
      return { kind: "time", draft: { day, minutes: pmMinutes } };
    }

    // Chrono may have advanced an ambiguous morning time before we interpret it as PM.
    const today = { day: localMidnight(now), minutes: pmMinutes };
    if (!snoozeDraftIsPast(today, now)) return { kind: "time", draft: today };
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { kind: "time", draft: { day: tomorrow, minutes: pmMinutes } };
  }

  // A day-only parse implies either noon or the reference time, depending on the locale and phrase.
  if (minutes === NOON_MINUTES || minutes === localMinutes(now)) {
    return { kind: "time", draft: snoozeDraftOnDay(day, fallbackMinutes, now) };
  }

  return {
    kind: "time",
    draft: { day, minutes: minutes < NOON_MINUTES ? MORNING_HOUR * MINUTES_PER_HOUR : minutes },
  };
}

export function snoozeDraftIsPast(draft: SnoozeDraft, now: Date): boolean {
  return snoozeDraftInstant(draft) < earliestSnoozeInstant(now);
}
