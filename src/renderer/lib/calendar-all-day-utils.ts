const DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface AllDaySegmentInput {
  id: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

export interface AllDaySegment<T extends AllDaySegmentInput> {
  event: T;
  startDayIndex: number;
  endDayIndex: number;
}

export interface PackedAllDaySegment<T extends AllDaySegmentInput> extends AllDaySegment<T> {
  lane: number;
}

function normalizeDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = normalizeDay(date);
  next.setDate(next.getDate() + days);
  return next;
}

function daysBetween(start: Date, end: Date): number {
  return Math.round((normalizeDay(end).getTime() - normalizeDay(start).getTime()) / DAY_MS);
}

export function resolveAllDaySpanDays(start: Date, end: Date): number {
  const byDay = daysBetween(start, end);
  if (byDay > 0) return byDay;
  const byDuration = Math.ceil((end.getTime() - start.getTime()) / DAY_MS);
  return Math.max(1, byDuration);
}

export function resolveTimedToAllDaySpanDays(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  return Math.max(1, Math.ceil(durationMs / DAY_MS));
}

export function resolveAllDayToTimedDurationMs(
  originalDurationMs: number,
  fallbackMs: number = ONE_HOUR_MS,
): number {
  if (!Number.isFinite(originalDurationMs) || originalDurationMs <= 0) return fallbackMs;
  if (originalDurationMs >= DAY_MS) return fallbackMs;
  return originalDurationMs;
}

export function toAllDayRangeFromTimedDrop(dayDate: Date, timedDurationMs: number): { start: Date; end: Date } {
  const start = normalizeDay(dayDate);
  const spanDays = resolveTimedToAllDaySpanDays(timedDurationMs);
  return { start, end: addDays(start, spanDays) };
}

export function segmentAllDayEvent<T extends AllDaySegmentInput>(
  event: T,
  visibleDays: Date[],
): AllDaySegment<T> | null {
  if (visibleDays.length === 0) return null;
  const windowStart = normalizeDay(visibleDays[0]);
  const windowEnd = addDays(visibleDays[visibleDays.length - 1], 1);

  const eventStart = normalizeDay(event.scheduledStart);
  let eventEnd = normalizeDay(event.scheduledEnd);
  if (eventEnd.getTime() <= eventStart.getTime()) {
    eventEnd = addDays(eventStart, 1);
  }

  if (eventEnd <= windowStart || eventStart >= windowEnd) return null;

  const clippedStart = eventStart < windowStart ? windowStart : eventStart;
  const clippedEnd = eventEnd > windowEnd ? windowEnd : eventEnd;
  const startDayIndex = Math.max(0, daysBetween(windowStart, clippedStart));
  const endDayIndex = Math.min(visibleDays.length, daysBetween(windowStart, clippedEnd));
  if (endDayIndex <= startDayIndex) return null;

  return { event, startDayIndex, endDayIndex };
}

export function buildAllDaySegments<T extends AllDaySegmentInput>(
  events: T[],
  visibleDays: Date[],
): Array<AllDaySegment<T>> {
  return events
    .map((event) => segmentAllDayEvent(event, visibleDays))
    .filter((segment): segment is AllDaySegment<T> => Boolean(segment));
}

export function packAllDaySegments<T extends AllDaySegmentInput>(
  segments: Array<AllDaySegment<T>>,
): Array<PackedAllDaySegment<T>> {
  if (segments.length === 0) return [];

  const sorted = [...segments].sort((left, right) => {
    if (left.startDayIndex !== right.startDayIndex) {
      return left.startDayIndex - right.startDayIndex;
    }
    return right.endDayIndex - left.endDayIndex;
  });

  const laneEnds: number[] = [];
  const packed: Array<PackedAllDaySegment<T>> = [];

  for (const segment of sorted) {
    let lane = laneEnds.findIndex((endIndex) => endIndex <= segment.startDayIndex);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(segment.endDayIndex);
    } else {
      laneEnds[lane] = segment.endDayIndex;
    }

    packed.push({ ...segment, lane });
  }

  return packed;
}

