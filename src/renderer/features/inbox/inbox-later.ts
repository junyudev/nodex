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
export function formatLaterTime(remindAt: string, now: Date, locale?: string): string {
  return formatChatReminderTime(remindAt, now, locale) ?? "";
}

/** The same, standing alone as a label: "Tomorrow at 9:00 AM". */
export const describeLaterTime = (remindAt: string, now: Date, locale?: string): string =>
  capitalize(formatLaterTime(remindAt, now, locale));

/** What a message says in its place once it is set aside: "Later · tomorrow at 9:00 AM". */
export const describeLaterOutcome = (remindAt: string, now: Date, locale?: string): string =>
  `Later · ${formatLaterTime(remindAt, now, locale)}`;

/** Confirms setting messages aside: "Set aside until tomorrow at 9:00 AM". */
export function describeLaterConfirmation(
  remindAt: string,
  count: number,
  now: Date,
  locale?: string,
): string {
  const subject = count > 1 ? `Set ${count} messages aside` : "Set aside";
  return `${subject} until ${formatLaterTime(remindAt, now, locale)}`;
}

/**
 * Why a message is in the Inbox again, said above it: "Back from Later · set aside yesterday".
 * Null unless the message has come back and not been handled since.
 */
export function describeBackFromLater(
  later: InboxLater | null | undefined,
  now: Date,
  locale?: string,
): string | null {
  if (!later || Date.parse(later.until) > now.getTime()) return null;
  const setAt = new Date(later.setAt);
  if (!Number.isFinite(setAt.getTime())) return "Back from Later";
  const days = -dayDistance(setAt, now);
  const when =
    days <= 0
      ? "earlier today"
      : days === 1
        ? "yesterday"
        : `on ${new Intl.DateTimeFormat(locale, {
            month: "short",
            day: "numeric",
            ...(setAt.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
          }).format(setAt)}`;
  return `Back from Later · set aside ${when}`;
}

export interface LaterSection {
  readonly key: string;
  /** The day its messages come back: "Today", "Tomorrow", "Thursday", "Nov 25". */
  readonly label: string;
  readonly items: readonly InboxItem[];
}

const laterDayLabel = (date: Date, now: Date, locale?: string): string => {
  const days = dayDistance(date, now);
  // A time already reached returns within moments; until then it still reads as today's.
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
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
  locale?: string,
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
export function formatLaterClock(remindAt: string, locale?: string): string | null {
  const date = new Date(remindAt);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
}
