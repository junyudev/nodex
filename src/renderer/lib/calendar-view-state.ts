import {
  type CalendarRangeState,
  resolveCalendarRangeAnchorOffset,
  resolveCalendarVisibleDayCount,
} from "./calendar-range";
import { getVisibleDays } from "./calendar-utils";

export interface CalendarViewState {
  range: CalendarRangeState;
  anchorDate: Date;
}

export function normalizeCalendarAnchorDate(value: Date): Date {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function shiftCalendarAnchorDateByDays(value: Date, days: number): Date {
  const next = normalizeCalendarAnchorDate(value);
  next.setDate(next.getDate() + days);
  return next;
}

export function resolveCalendarVisibleDays(state: CalendarViewState): Date[] {
  const dayCount = resolveCalendarVisibleDayCount(state.range);
  const effectiveAnchor = shiftCalendarAnchorDateByDays(
    state.anchorDate,
    resolveCalendarRangeAnchorOffset(state.range),
  );
  return getVisibleDays(effectiveAnchor, dayCount);
}

export function formatCalendarToolbarMonthYear(visibleDays: Date[]): string {
  if (visibleDays.length === 0) return "";
  const first = visibleDays[0]!;
  const last = visibleDays[visibleDays.length - 1]!;

  if (first.getFullYear() === last.getFullYear() && first.getMonth() === last.getMonth()) {
    return first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  if (first.getFullYear() === last.getFullYear()) {
    return `${first.toLocaleDateString(undefined, { month: "short" })} - ${last.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
  }

  return `${first.toLocaleDateString(undefined, { month: "short", year: "numeric" })} - ${last.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
}
