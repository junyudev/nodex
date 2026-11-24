import { getIntl } from "@/lib/i18n";
import type { InboxItem, InboxSnooze } from "../../../shared/inbox";
import { formatChatSnoozeTime } from "@/lib/chat-snooze";

/**
 * Snoozed holds the messages a reader set aside until a time. Setting one aside decides nothing:
 * it is the same waiting message, out of the Inbox until then. These helpers say when it comes
 * back, the same way wherever Snoozed is named: a row's decision, the Snoozed view, a toast.
 */

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const dayDistance = (date: Date, now: Date) =>
  Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** When a set-aside message comes back, mid-sentence: "tomorrow at 9:00 AM". */
export function formatInboxSnoozeTime(
  snoozedUntil: string,
  now: Date,
  locale = getIntl().locale,
): string {
  return formatChatSnoozeTime(snoozedUntil, now, locale) ?? "";
}

/** The same, standing alone as a label: "Tomorrow at 9:00 AM". */
export const describeInboxSnoozeTime = (
  snoozedUntil: string,
  now: Date,
  locale = getIntl().locale,
): string => capitalize(formatInboxSnoozeTime(snoozedUntil, now, locale));

/** What a message says in its place once it is set aside: "Snoozed · tomorrow at 9:00 AM". */
export const describeInboxSnoozedOutcome = (
  snoozedUntil: string,
  now: Date,
  locale = getIntl().locale,
): string =>
  getIntl().formatMessage(
    { id: "inbox.inboxSnooze.snoozedValue", defaultMessage: "Snoozed · {value1}" },
    { value1: formatInboxSnoozeTime(snoozedUntil, now, locale) },
  );

/** Confirms setting messages aside: "Set aside until tomorrow at 9:00 AM". */
export function describeInboxSnoozeConfirmation(
  snoozedUntil: string,
  count: number,
  now: Date,
  locale = getIntl().locale,
): string {
  const subject =
    count > 1
      ? getIntl().formatMessage(
          {
            id: "inbox.inboxSnooze.snoozedMessages",
            defaultMessage: "Snoozed {value1} messages",
          },
          { value1: count },
        )
      : getIntl().formatMessage({ id: "inbox.inboxSnooze.snoozed", defaultMessage: "Snoozed" });
  return getIntl().formatMessage(
    { id: "inbox.inboxSnooze.valueUntilValue", defaultMessage: "{value1} until {value2}" },
    { value1: subject, value2: formatInboxSnoozeTime(snoozedUntil, now, locale) },
  );
}

/**
 * Why a message is in the Inbox again, said above it: "Back from snooze · set yesterday".
 * Null unless the message has come back and not been handled since.
 */
export function describeBackFromSnooze(
  snooze: InboxSnooze | null | undefined,
  now: Date,
  locale = getIntl().locale,
): string | null {
  if (!snooze || Date.parse(snooze.until) > now.getTime()) return null;
  const setAt = new Date(snooze.setAt);
  if (!Number.isFinite(setAt.getTime()))
    return getIntl().formatMessage({
      id: "inbox.inboxSnooze.backFromSnooze",
      defaultMessage: "Back from snooze",
    });
  const days = -dayDistance(setAt, now);
  const when =
    days <= 0
      ? getIntl().formatMessage({
          id: "inbox.inboxSnooze.earlierToday",
          defaultMessage: "earlier today",
        })
      : days === 1
        ? getIntl().formatMessage({
            id: "inbox.inboxSnooze.yesterdayTime",
            defaultMessage: "yesterday",
          })
        : getIntl().formatMessage(
            { id: "inbox.inboxSnooze.snoozedOn", defaultMessage: "on {value1}" },
            {
              value1: new Intl.DateTimeFormat(locale, {
                month: "short",
                day: "numeric",
                ...(setAt.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
              }).format(setAt),
            },
          );
  return getIntl().formatMessage(
    {
      id: "inbox.inboxSnooze.backFromSnoozeSetAt",
      defaultMessage: "Back from snooze · set {value1}",
    },
    { value1: when },
  );
}

export interface SnoozedSection {
  readonly key: string;
  /** The day its messages come back: "Today", "Tomorrow", "Thursday", "Nov 25". */
  readonly label: string;
  readonly items: readonly InboxItem[];
}

const snoozedDayLabel = (date: Date, now: Date, locale = getIntl().locale): string => {
  const days = dayDistance(date, now);
  // A time already reached returns within moments; until then it still reads as today's.
  if (days <= 0)
    return getIntl().formatMessage({ id: "inbox.inboxSnooze.todayTime", defaultMessage: "Today" });
  if (days === 1)
    return getIntl().formatMessage({
      id: "inbox.inboxSnooze.tomorrowTime",
      defaultMessage: "Tomorrow",
    });
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
  }).format(date);
};

/**
 * Groups the Snoozed window by the day each message comes back, keeping Core's soonest-first order.
 */
export function snoozedSections(
  items: readonly InboxItem[],
  now: Date,
  locale = getIntl().locale,
): readonly SnoozedSection[] {
  const sections: { key: string; label: string; items: InboxItem[] }[] = [];
  for (const item of items) {
    if (!item.snooze) continue;
    const date = new Date(item.snooze.until);
    const label = snoozedDayLabel(date, now, locale);
    const key = `day:${label}`;
    const current = sections.at(-1);
    if (current?.key === key) current.items.push(item);
    else sections.push({ key, label, items: [item] });
  }
  return sections;
}

/** The time of day a set-aside message comes back, for its row in a day's section. */
export function formatSnoozeClock(snoozedUntil: string, locale = getIntl().locale): string | null {
  const date = new Date(snoozedUntil);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
}
