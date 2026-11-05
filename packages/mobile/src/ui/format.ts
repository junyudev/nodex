const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const WEEKDAYS = "Sun Mon Tue Wed Thu Fri Sat".split(" ");

/** A compact age for list rows, in the viewer's local time. */
export const formatAge = (at: number, now: number): string => {
  const elapsed = now - at;
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  const date = new Date(at);
  if (elapsed < 7 * DAY) return WEEKDAYS[date.getDay()] ?? "";
  const monthDay = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? monthDay
    : `${monthDay}, ${date.getFullYear()}`;
};

/** A message's time within the stream: the clock today, otherwise the date too. */
export const formatStreamTime = (at: number, now: number): string => {
  const date = new Date(at);
  const clock = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  ) {
    return clock;
  }
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${clock}`;
};
