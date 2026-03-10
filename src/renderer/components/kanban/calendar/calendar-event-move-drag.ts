import {
  slotRangeToDates,
  moveSlotRange,
  TOTAL_SLOTS,
  type SlotRange,
} from "../../../lib/calendar-utils";
import {
  resolveAllDayToTimedDurationMs,
  resolveTimedToAllDaySpanDays,
  toAllDayRangeFromTimedDrop,
} from "../../../lib/calendar-all-day-utils";

export interface CalendarMoveDragSession {
  eventId: string;
  originDayIndex: number;
  originRange: SlotRange;
  originIsAllDay: boolean;
  originalDurationMs: number;
  originalAllDaySpanDays: number;
  grabOffsetSlots: number;
}

export type CalendarMoveDropTarget =
  | { region: "timed"; dayIndex: number; slot: number }
  | { region: "all-day"; dayIndex: number };

export type CalendarMovePreview =
  | { kind: "timed"; dayIndex: number; range: SlotRange }
  | { kind: "all-day"; startDayIndex: number; endDayIndex: number };

export interface CalendarMoveDropSchedule {
  start: Date;
  end: Date;
  isAllDay: boolean;
}

function resolveTimedRangeFromTarget(
  session: CalendarMoveDragSession,
  target: Extract<CalendarMoveDropTarget, { region: "timed" }>,
): SlotRange {
  if (!session.originIsAllDay) {
    return moveSlotRange(session.originRange, target.slot, session.grabOffsetSlots);
  }

  const durationMs = resolveAllDayToTimedDurationMs(session.originalDurationMs);
  const durationSlots = Math.max(1, Math.ceil(durationMs / (15 * 60 * 1000)));
  const startSlot = Math.max(0, Math.min(target.slot, TOTAL_SLOTS - durationSlots));
  const endSlot = Math.min(TOTAL_SLOTS - 1, startSlot + durationSlots - 1);
  return { startSlot, endSlot };
}

function normalizeDay(value: Date): Date {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function resolveCalendarMovePreview(
  session: CalendarMoveDragSession,
  target: CalendarMoveDropTarget | null,
): CalendarMovePreview | null {
  if (!target) return null;

  if (target.region === "timed") {
    return {
      kind: "timed",
      dayIndex: target.dayIndex,
      range: resolveTimedRangeFromTarget(session, target),
    };
  }

  const spanDays = session.originIsAllDay
    ? Math.max(1, session.originalAllDaySpanDays)
    : resolveTimedToAllDaySpanDays(session.originalDurationMs);

  return {
    kind: "all-day",
    startDayIndex: target.dayIndex,
    endDayIndex: target.dayIndex + spanDays,
  };
}

export function resolveCalendarMoveDropSchedule(
  session: CalendarMoveDragSession,
  target: CalendarMoveDropTarget | null,
  visibleDays: Date[],
): CalendarMoveDropSchedule | null {
  if (!target) return null;
  const dayDate = visibleDays[target.dayIndex];
  if (!dayDate) return null;

  if (target.region === "timed") {
    const range = resolveTimedRangeFromTarget(session, target);
    const dates = slotRangeToDates(dayDate, range);
    return {
      start: dates.start,
      end: dates.end,
      isAllDay: false,
    };
  }

  if (session.originIsAllDay) {
    const start = normalizeDay(dayDate);
    const end = normalizeDay(dayDate);
    end.setDate(end.getDate() + Math.max(1, session.originalAllDaySpanDays));
    return {
      start,
      end,
      isAllDay: true,
    };
  }

  const range = toAllDayRangeFromTimedDrop(dayDate, session.originalDurationMs);
  return {
    start: range.start,
    end: range.end,
    isAllDay: true,
  };
}
