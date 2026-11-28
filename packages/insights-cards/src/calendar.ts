import type { ShareCardDay } from "./view";

/** Sunday-first weeks of consecutive days; a null cell lies outside them. */
export function shareCardCalendar<Day extends ShareCardDay>(
  days: readonly Day[],
): { readonly weeks: readonly (readonly (Day | null)[])[] } {
  const weeks: (Day | null)[][] = [];
  let week: (Day | null)[] = Array.from({ length: 7 }, () => null);
  for (const entry of days) {
    const weekday = new Date(`${entry.day}T00:00:00.000Z`).getUTCDay();
    week[weekday] = entry;
    if (weekday === 6) {
      weeks.push(week);
      week = Array.from({ length: 7 }, () => null);
    }
  }
  if (week.some((cell) => cell !== null)) weeks.push(week);
  return { weeks };
}
