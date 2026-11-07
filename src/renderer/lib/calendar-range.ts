export type CalendarRangeMode = "day" | "week" | "multi-day" | "multi-week";

export const DEFAULT_CALENDAR_RANGE_MODE: CalendarRangeMode = "week";
export const DEFAULT_MULTI_DAY_COUNT = 4;
export const DEFAULT_MULTI_WEEK_COUNT = 2;
export const MIN_MULTI_DAY_COUNT = 2;
export const MAX_MULTI_DAY_COUNT = 14;
export const MIN_MULTI_WEEK_COUNT = 2;
export const MAX_MULTI_WEEK_COUNT = 4;

export interface CalendarRangeState {
  mode: CalendarRangeMode;
  multiDayCount: number;
  multiWeekCount: number;
}

export function clampCalendarMultiDayCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MULTI_DAY_COUNT;
  return Math.max(MIN_MULTI_DAY_COUNT, Math.min(Math.round(value), MAX_MULTI_DAY_COUNT));
}

export function clampCalendarMultiWeekCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MULTI_WEEK_COUNT;
  return Math.max(MIN_MULTI_WEEK_COUNT, Math.min(Math.round(value), MAX_MULTI_WEEK_COUNT));
}

export function normalizeCalendarRangeState(
  input: Partial<CalendarRangeState> | null | undefined,
): CalendarRangeState {
  const mode = isCalendarRangeMode(input?.mode) ? input.mode : DEFAULT_CALENDAR_RANGE_MODE;

  return {
    mode,
    multiDayCount: clampCalendarMultiDayCount(input?.multiDayCount ?? DEFAULT_MULTI_DAY_COUNT),
    multiWeekCount: clampCalendarMultiWeekCount(input?.multiWeekCount ?? DEFAULT_MULTI_WEEK_COUNT),
  };
}

export function migrateCalendarRangePrefs(input: unknown): CalendarRangeState {
  if (!input || typeof input !== "object") return normalizeCalendarRangeState(null);

  const candidate = input as {
    dayCount?: unknown;
    mode?: unknown;
    multiDayCount?: unknown;
    multiWeekCount?: unknown;
  };

  if (candidate.dayCount === 4) {
    return normalizeCalendarRangeState({
      mode: "multi-day",
      multiDayCount: 4,
      multiWeekCount: Number(candidate.multiWeekCount),
    });
  }

  if (candidate.dayCount === 7) {
    return normalizeCalendarRangeState({
      mode: "week",
      multiDayCount: Number(candidate.multiDayCount),
      multiWeekCount: Number(candidate.multiWeekCount),
    });
  }

  return normalizeCalendarRangeState({
    mode:
      candidate.mode === "day" ||
      candidate.mode === "week" ||
      candidate.mode === "multi-day" ||
      candidate.mode === "multi-week"
        ? candidate.mode
        : undefined,
    multiDayCount: Number(candidate.multiDayCount),
    multiWeekCount: Number(candidate.multiWeekCount),
  });
}

export function resolveCalendarVisibleDayCount(range: CalendarRangeState): number {
  if (range.mode === "day") return 1;
  if (range.mode === "week") return 7;
  if (range.mode === "multi-day") return clampCalendarMultiDayCount(range.multiDayCount);
  return clampCalendarMultiWeekCount(range.multiWeekCount) * 7;
}

export function formatCalendarRangeLabel(range: CalendarRangeState): string {
  if (range.mode === "day") return "Day";
  if (range.mode === "week") return "Week";

  if (range.mode === "multi-day") {
    const count = clampCalendarMultiDayCount(range.multiDayCount);
    return `${count} ${count === 1 ? "Day" : "Days"}`;
  }

  const count = clampCalendarMultiWeekCount(range.multiWeekCount);
  return `${count} ${count === 1 ? "Week" : "Weeks"}`;
}

export function formatCalendarRangeStaticValue(
  mode: CalendarRangeMode,
  range: CalendarRangeState,
): string {
  if (mode === "day") return "1 Day";
  if (mode === "week") return "1 Week";
  if (mode === "multi-day") {
    const count = clampCalendarMultiDayCount(range.multiDayCount);
    return `${count} Days`;
  }
  const count = clampCalendarMultiWeekCount(range.multiWeekCount);
  return `${count} Weeks`;
}

export function resolveCalendarRangeAnchorOffset(range: CalendarRangeState): number {
  if (range.mode !== "multi-day") return 0;
  return -Math.floor((clampCalendarMultiDayCount(range.multiDayCount) - 1) / 2);
}

function isCalendarRangeMode(value: unknown): value is CalendarRangeMode {
  return value === "day" || value === "week" || value === "multi-day" || value === "multi-week";
}
