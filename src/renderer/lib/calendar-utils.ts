/** Calendar view helper utilities — pure functions, no side effects. */

export const HOUR_HEIGHT = 60;
export const MIN_HOUR_HEIGHT = 32;
export const SLOT_MINUTES = 15;
export const SLOTS_PER_HOUR = 60 / SLOT_MINUTES;
export const TOTAL_SLOTS = 24 * SLOTS_PER_HOUR;
export const GUTTER_WIDTH = 56;
const WHEEL_LINE_HEIGHT_PX = 16;

/**
 * Calculate the hour height so the full 24h timeline fits in the visible panel
 * whenever possible, while preserving a readable minimum height.
 */
export function resolveHourHeight(
  availableTimelineHeight: number,
  minHourHeight: number = MIN_HOUR_HEIGHT,
): number {
  if (!Number.isFinite(availableTimelineHeight) || availableTimelineHeight <= 0) {
    return HOUR_HEIGHT;
  }

  const fitted = Math.max(minHourHeight, availableTimelineHeight / 24);
  return Math.round(fitted * 100) / 100;
}

/**
 * Compute timeline viewport height from panel chrome measurements.
 */
export function resolveTimelineViewportHeight({
  panelHeight,
  headerHeight,
  allDayLaneHeight,
  separatorHeight,
}: {
  panelHeight: number;
  headerHeight: number;
  allDayLaneHeight: number;
  separatorHeight: number;
}): number {
  if (!Number.isFinite(panelHeight) || panelHeight <= 0) return 0;

  const resolvedHeaderHeight = Number.isFinite(headerHeight) ? Math.max(headerHeight, 0) : 0;
  const resolvedAllDayLaneHeight = Number.isFinite(allDayLaneHeight) ? Math.max(allDayLaneHeight, 0) : 0;
  const resolvedSeparatorHeight = Number.isFinite(separatorHeight) ? Math.max(separatorHeight, 0) : 0;

  return Math.max(
    panelHeight - resolvedHeaderHeight - resolvedAllDayLaneHeight - resolvedSeparatorHeight,
    0,
  );
}

export interface ShiftWheelDeltaInput {
  shiftKey: boolean;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  pageHeight: number;
}

export interface ShiftWheelDirectionInput extends ShiftWheelDeltaInput {
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface SlotRange {
  startSlot: number;
  endSlot: number;
}

/** Normalize wheel deltas so Shift+wheel interactions are consistent across devices. */
export function resolveShiftWheelDelta({
  shiftKey,
  deltaX,
  deltaY,
  deltaMode,
  pageHeight,
}: ShiftWheelDeltaInput): number {
  if (!shiftKey) return 0;

  const rawDelta = deltaX !== 0 ? deltaX : deltaY;
  if (rawDelta === 0) return 0;

  if (deltaMode === 1) return rawDelta * WHEEL_LINE_HEIGHT_PX; // delta in lines
  if (deltaMode === 2 && pageHeight > 0) return rawDelta * pageHeight; // delta in pages
  return rawDelta; // delta in pixels (or fallback)
}

export function resolveShiftWheelDirection({
  shiftKey,
  ctrlKey,
  metaKey,
  deltaX,
  deltaY,
  deltaMode,
  pageHeight,
}: ShiftWheelDirectionInput): -1 | 0 | 1 {
  if (ctrlKey || metaKey) return 0;

  const delta = resolveShiftWheelDelta({
    shiftKey,
    deltaX,
    deltaY,
    deltaMode,
    pageHeight,
  });
  if (delta === 0) return 0;
  return delta > 0 ? 1 : -1;
}

/** Return an array of Date objects (midnight-local) for the visible day columns. */
export function getVisibleDays(anchorDate: Date, dayCount: number): Date[] {
  const start = new Date(anchorDate);
  start.setHours(0, 0, 0, 0);

  return Array.from({ length: dayCount }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/** Snap a relative Y pixel offset to the nearest slot index. */
export function snapToSlot(y: number, hourHeight: number = HOUR_HEIGHT): number {
  const slotHeight = hourHeight / SLOTS_PER_HOUR;
  return Math.max(0, Math.min(Math.floor(y / slotHeight), TOTAL_SLOTS - 1));
}

export function clampSlot(slot: number): number {
  return Math.max(0, Math.min(slot, TOTAL_SLOTS - 1));
}

export function slotRangeFromDates(start: Date, end: Date): SlotRange {
  const startOfDay = new Date(start);
  startOfDay.setHours(0, 0, 0, 0);

  const startMinutes = Math.floor((start.getTime() - startOfDay.getTime()) / 60000);
  const endMinutes = Math.ceil((end.getTime() - startOfDay.getTime()) / 60000);
  const startSlot = clampSlot(Math.floor(startMinutes / SLOT_MINUTES));
  const endExclusiveSlot = Math.max(
    startSlot + 1,
    Math.min(TOTAL_SLOTS, Math.ceil(endMinutes / SLOT_MINUTES)),
  );

  return { startSlot, endSlot: endExclusiveSlot - 1 };
}

export function slotRangeToDates(dayDate: Date, range: SlotRange): { start: Date; end: Date } {
  const startSlot = clampSlot(range.startSlot);
  const endSlot = clampSlot(Math.max(range.endSlot, startSlot));
  const startTime = slotToTime(startSlot);
  const endExclusiveSlot = Math.min(TOTAL_SLOTS, endSlot + 1);
  const endTime = slotToTime(endExclusiveSlot);

  const start = new Date(dayDate);
  start.setHours(startTime.hour, startTime.minute, 0, 0);

  const end = new Date(dayDate);
  end.setHours(endTime.hour, endTime.minute, 0, 0);

  return { start, end };
}

export function moveSlotRange(
  range: SlotRange,
  pointerSlot: number,
  grabOffsetSlots: number,
): SlotRange {
  const startSlot = clampSlot(range.startSlot);
  const endSlot = clampSlot(Math.max(range.endSlot, startSlot));
  const durationSlots = endSlot - startSlot + 1;
  const maxStart = Math.max(0, TOTAL_SLOTS - durationSlots);
  const nextStart = Math.max(
    0,
    Math.min(pointerSlot - grabOffsetSlots, maxStart),
  );

  return {
    startSlot: nextStart,
    endSlot: nextStart + durationSlots - 1,
  };
}

export function resizeSlotRange(
  range: SlotRange,
  pointerSlot: number,
  edge: "start" | "end",
): SlotRange {
  const startSlot = clampSlot(range.startSlot);
  const endSlot = clampSlot(Math.max(range.endSlot, startSlot));

  if (edge === "start") {
    return {
      startSlot: Math.min(clampSlot(pointerSlot), endSlot),
      endSlot,
    };
  }

  return {
    startSlot,
    endSlot: Math.max(clampSlot(pointerSlot), startSlot),
  };
}

/** Convert an hour + minute to a Y pixel offset. */
export function timeToY(hour: number, minute: number, hourHeight: number = HOUR_HEIGHT): number {
  return (hour * 60 + minute) * (hourHeight / 60);
}

/** Resolve the current-time marker Y using sub-minute precision. */
export function resolveNowY(now: Date, hourHeight: number = HOUR_HEIGHT): number {
  const effectiveHourHeight = Number.isFinite(hourHeight) && hourHeight > 0
    ? hourHeight
    : HOUR_HEIGHT;
  const minutesSinceMidnight = now.getHours() * 60
    + now.getMinutes()
    + now.getSeconds() / 60
    + now.getMilliseconds() / 60000;
  return minutesSinceMidnight * (effectiveHourHeight / 60);
}

/** Convert a Y pixel offset to { hour, minute }. */
export function yToTime(y: number, hourHeight: number = HOUR_HEIGHT): { hour: number; minute: number } {
  const totalMinutes = Math.round(y / (hourHeight / 60));
  const clamped = Math.max(0, Math.min(totalMinutes, 24 * 60 - 1));
  return { hour: Math.floor(clamped / 60), minute: clamped % 60 };
}

/** Convert a slot index to { hour, minute }. */
export function slotToTime(slot: number): { hour: number; minute: number } {
  const totalMinutes = slot * SLOT_MINUTES;
  return { hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60 };
}

/** Format a time range like "9:00 AM – 10:30 AM". */
export function formatTimeRange(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${fmt(start)} – ${fmt(end)}`;
}

/** Format a single time like "9:00 AM". */
export function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

/** Check if two dates represent the same calendar day (local time). */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Check if a date falls within a range of visible days. */
export function isInVisibleRange(date: Date, visibleDays: Date[]): boolean {
  if (visibleDays.length === 0) return false;
  const first = visibleDays[0];
  const last = visibleDays[visibleDays.length - 1];
  const nextDay = new Date(last);
  nextDay.setDate(nextDay.getDate() + 1);
  return date >= first && date < nextDay;
}

export interface CalendarEvent {
  id: string;
  title: string;
  columnId: string;
  columnName: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  priority: string;
  lane: number;
  totalLanes: number;
}

/** Assign lane indices for overlapping events on the same day. */
export function groupOverlapping<T extends { scheduledStart: Date; scheduledEnd: Date }>(
  events: T[],
): (T & { lane: number; totalLanes: number })[] {
  if (events.length === 0) return [];

  const sorted = [...events].sort(
    (a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime(),
  );

  const laneAssignments = new Array<{ lane: number; totalLanes: number }>(sorted.length);
  const activeLaneEndMs = new Map<number, number>();
  const reusableLanes: number[] = [];
  let nextLane = 0;

  let componentStartIndex = 0;
  let componentEndMs = Number.NEGATIVE_INFINITY;
  let componentPeakOverlap = 0;

  const finalizeComponent = (startIndex: number, endIndex: number, totalLanes: number) => {
    for (let i = startIndex; i <= endIndex; i++) {
      laneAssignments[i].totalLanes = totalLanes;
    }
  };

  const releaseInactiveLanes = (startMs: number) => {
    for (const [lane, endMs] of activeLaneEndMs) {
      if (endMs > startMs) continue;
      activeLaneEndMs.delete(lane);
      reusableLanes.push(lane);
    }
    reusableLanes.sort((a, b) => a - b);
  };

  for (let i = 0; i < sorted.length; i++) {
    const startMs = sorted[i].scheduledStart.getTime();
    const endMs = sorted[i].scheduledEnd.getTime();

    // Component boundary: current event no longer intersects the active chain.
    if (i === 0 || startMs >= componentEndMs) {
      if (i > 0) {
        finalizeComponent(componentStartIndex, i - 1, Math.max(componentPeakOverlap, 1));
      }
      componentStartIndex = i;
      componentEndMs = endMs;
      componentPeakOverlap = 0;
      activeLaneEndMs.clear();
      reusableLanes.length = 0;
      nextLane = 0;
    } else {
      componentEndMs = Math.max(componentEndMs, endMs);
    }

    releaseInactiveLanes(startMs);

    const lane = reusableLanes.length > 0 ? reusableLanes.shift()! : nextLane++;
    activeLaneEndMs.set(lane, endMs);
    componentPeakOverlap = Math.max(componentPeakOverlap, activeLaneEndMs.size);

    laneAssignments[i] = { lane, totalLanes: 1 };
  }

  finalizeComponent(componentStartIndex, sorted.length - 1, Math.max(componentPeakOverlap, 1));
  return sorted.map((event, i) => ({ ...event, ...laneAssignments[i] }));
}
