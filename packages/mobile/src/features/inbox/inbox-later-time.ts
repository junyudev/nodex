const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dated = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const localDay = (date: Date, offset: number): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);

const morning = (date: Date, offset: number): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, 9);

const roundUpToMinute = (time: number): Date => {
  const date = new Date(time);
  if (date.getSeconds() > 0 || date.getMilliseconds() > 0) {
    date.setSeconds(0, 0);
    date.setMinutes(date.getMinutes() + 1);
  }
  return date;
};

/** The same local calendar choices as chat reminders. */
export function inboxLaterPresets(
  now: Date,
): readonly { readonly label: string; readonly remindAt: string }[] {
  const today = morning(now, 0);
  const thisMorning = today.getTime() - now.getTime() >= 3 * HOUR;
  const nextMorning = thisMorning ? today : morning(now, 1);
  const nextMonday = morning(now, (8 - now.getDay()) % 7 || 7);
  const timed = [
    { label: "In 1 hour", at: roundUpToMinute(now.getTime() + HOUR) },
    { label: "In 3 hours", at: roundUpToMinute(now.getTime() + 3 * HOUR) },
    {
      label: `${thisMorning ? "This morning" : "Tomorrow"}, ${clock.format(nextMorning)}`,
      at: nextMorning,
    },
    {
      label: `Next week, ${weekday.format(nextMonday)} ${clock.format(nextMonday)}`,
      at: nextMonday,
    },
  ];
  const choices = new Map<string, string>();
  for (const { label, at } of timed) {
    const instant = at.toISOString();
    if (!choices.has(instant)) choices.set(instant, label);
  }
  return Array.from(choices, ([remindAt, label]) => ({ label, remindAt }));
}

/** A scheduled return as it reads on the phone, in the viewer's local time. */
export function formatLaterTime(remindAt: string, now: Date): string {
  const date = new Date(remindAt);
  const day = localDay(date, 0).getTime();
  const label =
    day === localDay(now, 0).getTime()
      ? "Today"
      : day === localDay(now, 1).getTime()
        ? "Tomorrow"
        : formatSetAsideDate(date, now);
  return `${label}, ${clock.format(date)}`;
}

export function formatSetAsideDate(date: Date, now: Date): string {
  return (date.getFullYear() === now.getFullYear() ? monthDay : dated).format(date);
}
