import {
  moveSlotRange,
  resizeSlotRange,
  slotRangeToDates,
  type SlotRange,
} from "../../../lib/calendar-utils";
import {
  resolveAllDayToTimedDurationMs,
  resolveTimedToAllDaySpanDays,
} from "../../../lib/calendar-all-day-utils";

export type CalendarEventInteractionMode = "move" | "resize-start" | "resize-end";

export interface CalendarEventGridPosition {
  dayIndex: number;
  slot: number;
}

export interface CalendarEventPreviewState {
  eventId: string;
  dayIndex: number;
  range: SlotRange;
}

export interface ActiveCalendarEventInteraction {
  eventId: string;
  mode: CalendarEventInteractionMode;
}

interface ScheduledCalendarEvent {
  id: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

export interface ResolveCalendarEventInteractionInput {
  eventId: string;
  mode: CalendarEventInteractionMode;
  originDayIndex: number;
  originRange: SlotRange;
  pointerStartX: number;
  pointerStartY: number;
  pointerX: number;
  pointerY: number;
  activationDistance: number;
  wasActivated: boolean;
  grabOffsetSlots: number;
  gridPosition: CalendarEventGridPosition | null;
}

export interface ResolvedCalendarEventInteraction {
  activated: boolean;
  preview: CalendarEventPreviewState | null;
}

function hasMoveActivated({
  wasActivated,
  pointerStartX,
  pointerStartY,
  pointerX,
  pointerY,
  activationDistance,
}: Pick<
  ResolveCalendarEventInteractionInput,
  "wasActivated" | "pointerStartX" | "pointerStartY" | "pointerX" | "pointerY" | "activationDistance"
>): boolean {
  if (wasActivated) return true;

  const distance = Math.hypot(pointerX - pointerStartX, pointerY - pointerStartY);
  return distance >= activationDistance;
}

export function createCalendarEventPreview(
  eventId: string,
  dayIndex: number,
  range: SlotRange,
): CalendarEventPreviewState {
  return { eventId, dayIndex, range };
}

export function areCalendarEventPreviewsEqual(
  a: CalendarEventPreviewState | null,
  b: CalendarEventPreviewState | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.eventId === b.eventId &&
    a.dayIndex === b.dayIndex &&
    a.range.startSlot === b.range.startSlot &&
    a.range.endSlot === b.range.endSlot
  );
}

export function resolveCalendarEventInteraction({
  eventId,
  mode,
  originDayIndex,
  originRange,
  pointerStartX,
  pointerStartY,
  pointerX,
  pointerY,
  activationDistance,
  wasActivated,
  grabOffsetSlots,
  gridPosition,
}: ResolveCalendarEventInteractionInput): ResolvedCalendarEventInteraction {
  if (mode === "move") {
    const activated = hasMoveActivated({
      wasActivated,
      pointerStartX,
      pointerStartY,
      pointerX,
      pointerY,
      activationDistance,
    });
    if (!activated) {
      return { activated: false, preview: null };
    }
    if (!gridPosition) {
      return { activated: true, preview: null };
    }

    return {
      activated: true,
      preview: createCalendarEventPreview(
        eventId,
        gridPosition.dayIndex,
        moveSlotRange(originRange, gridPosition.slot, grabOffsetSlots),
      ),
    };
  }

  if (!gridPosition) {
    return { activated: true, preview: null };
  }

  if (mode === "resize-start") {
    return {
      activated: true,
      preview: createCalendarEventPreview(
        eventId,
        originDayIndex,
        resizeSlotRange(originRange, gridPosition.slot, "start"),
      ),
    };
  }

  return {
    activated: true,
    preview: createCalendarEventPreview(
      eventId,
      originDayIndex,
      resizeSlotRange(originRange, gridPosition.slot, "end"),
    ),
  };
}

export function isMoveDragPreviewActive(
  activeInteraction: ActiveCalendarEventInteraction | null,
  preview: CalendarEventPreviewState | null,
): boolean {
  return Boolean(
    activeInteraction &&
    preview &&
    activeInteraction.mode === "move" &&
    activeInteraction.eventId === preview.eventId,
  );
}

export function applyPreviewToScheduledEvents<T extends ScheduledCalendarEvent>(
  events: T[],
  preview: CalendarEventPreviewState | null,
  visibleDays: Date[],
  {
    freezeLayout,
  }: {
    freezeLayout: boolean;
  },
): T[] {
  if (!preview || freezeLayout) return events;

  const dayDate = visibleDays[preview.dayIndex];
  if (!dayDate) return events;

  const nextRange = slotRangeToDates(dayDate, preview.range);
  return events.map((event) => {
    if (event.id !== preview.eventId) return event;
    return {
      ...event,
      scheduledStart: nextRange.start,
      scheduledEnd: nextRange.end,
    };
  });
}

export function resolveMovePreviewOverlayEvent<T extends ScheduledCalendarEvent>(
  eventsById: Map<string, T>,
  preview: CalendarEventPreviewState | null,
  visibleDays: Date[],
  {
    isMovePreviewActive,
  }: {
    isMovePreviewActive: boolean;
  },
): T | null {
  if (!isMovePreviewActive || !preview) return null;

  const dayDate = visibleDays[preview.dayIndex];
  const sourceEvent = eventsById.get(preview.eventId);
  if (!dayDate || !sourceEvent) return null;

  const nextRange = slotRangeToDates(dayDate, preview.range);
  return {
    ...sourceEvent,
    scheduledStart: nextRange.start,
    scheduledEnd: nextRange.end,
  };
}

export function resolveTimedToAllDaySpanDaysForDrag(durationMs: number): number {
  return resolveTimedToAllDaySpanDays(durationMs);
}

export function resolveAllDayToTimedDurationMsForDrag(durationMs: number): number {
  return resolveAllDayToTimedDurationMs(durationMs);
}
