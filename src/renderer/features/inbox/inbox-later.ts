import { getIntl } from "@/lib/i18n";
import type { InboxItem, InboxLater } from "../../../shared/inbox";
import { formatChatReminderTime } from "@/lib/chat-reminder";

/**
 * Later holds the messages a reader set aside until a time. Setting one aside decides nothing:
 * it is the same waiting message, out of the Inbox until then. These helpers say when it comes
 * back, the same way wherever Later is named: a row's decision, the Later view, a toast.
 */

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const dayDistance = (date: Date, now: Date) =>
  Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** When a set-aside message comes back, mid-sentence: "tomorrow at 9:00 AM". */
export function formatLaterTime(remindAt: string, now: Date, locale = getIntl().locale): string {
  return formatChatReminderTime(remindAt, now, locale) ?? "";
}

/** The same, standing alone as a label: "Tomorrow at 9:00 AM". */
export const describeLaterTime = (remindAt: string, now: Date, locale = getIntl().locale): string =>
  capitalize(formatLaterTime(remindAt, now, locale));

/** What a message says in its place once it is set aside: "Later · tomorrow at 9:00 AM". */
export const describeLaterOutcome = (
  remindAt: string,
  now: Date,
  locale = getIntl().locale,
): string =>
  getIntl().formatMessage(
    { id: "inbox.inboxLater.laterValue", defaultMessage: "Later · {value1}" },
    { value1: formatLaterTime(remindAt, now, locale) },
  );

/** Confirms setting messages aside: "Set aside until tomorrow at 9:00 AM". */
export function describeLaterConfirmation(
  remindAt: string,
  count: number,
  now: Date,
  locale = getIntl().locale,
): string {
  const subject =
    count > 1
      ? getIntl().formatMessage(
          {
            id: "inbox.inboxLater.setValueMessagesAside",
            defaultMessage: "Set {value1} messages aside",
          },
          { value1: count },
        )
      : getIntl().formatMessage({ id: "inbox.inboxLater.setAside", defaultMessage: "Set aside" });
  return getIntl().formatMessage(
    { id: "inbox.inboxLater.valueUntilValue", defaultMessage: "{value1} until {value2}" },
    { value1: subject, value2: formatLaterTime(remindAt, now, locale) },
  );
}

/**
 * Why a message is in the Inbox again, said above it: "Back from Later · set aside yesterday".
 * Null unless the message has come back and not been handled since.
 */
export function describeBackFromLater(
  later: InboxLater | null | undefined,
  now: Date,
  locale = getIntl().locale,
): string | null {
  if (!later || Date.parse(later.until) > now.getTime()) return null;
  const setAt = new Date(later.setAt);
  if (!Number.isFinite(setAt.getTime()))
    return getIntl().formatMessage({
      id: "inbox.inboxLater.backFromLater",
      defaultMessage: "Back from Later",
    });
  const days = -dayDistance(setAt, now);
  const when =
    days <= 0
      ? getIntl().formatMessage({
          id: "inbox.inboxLater.earlierToday",
          defaultMessage: "earlier today",
        })
      : days === 1
        ? getIntl().formatMessage({
            id: "inbox.inboxLater.yesterdayTime",
            defaultMessage: "yesterday",
          })
        : getIntl().formatMessage(
            { id: "inbox.inboxLater.setAsideOn", defaultMessage: "on {value1}" },
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
      id: "inbox.inboxLater.backFromLaterSetAside",
      defaultMessage: "Back from Later · set aside {value1}",
    },
    { value1: when },
  );
}

export interface LaterSection {
  readonly key: string;
  /** The day its messages come back: "Today", "Tomorrow", "Thursday", "Nov 25". */
  readonly label: string;
  readonly items: readonly InboxItem[];
}

const laterDayLabel = (date: Date, now: Date, locale = getIntl().locale): string => {
  const days = dayDistance(date, now);
  // A time already reached returns within moments; until then it still reads as today's.
  if (days <= 0)
    return getIntl().formatMessage({ id: "inbox.inboxLater.todayTime", defaultMessage: "Today" });
  if (days === 1)
    return getIntl().formatMessage({
      id: "inbox.inboxLater.tomorrowTime",
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
 * Groups the Later window by the day each message comes back, keeping Core's soonest-first order.
 */
export function laterSections(
  items: readonly InboxItem[],
  now: Date,
  locale = getIntl().locale,
): readonly LaterSection[] {
  const sections: { key: string; label: string; items: InboxItem[] }[] = [];
  for (const item of items) {
    if (!item.later) continue;
    const date = new Date(item.later.until);
    const label = laterDayLabel(date, now, locale);
    const key = `day:${label}`;
    const current = sections.at(-1);
    if (current?.key === key) current.items.push(item);
    else sections.push({ key, label, items: [item] });
  }
  return sections;
}

/** The time of day a set-aside message comes back, for its row in a day's section. */
export function formatLaterClock(remindAt: string, locale = getIntl().locale): string | null {
  const date = new Date(remindAt);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
}
