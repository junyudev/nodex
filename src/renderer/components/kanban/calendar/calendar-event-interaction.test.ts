import { describe, expect, test } from "bun:test";

import {
  applyPreviewToScheduledEvents,
  areCalendarEventPreviewsEqual,
  isMoveDragPreviewActive,
  resolveAllDayToTimedDurationMsForDrag,
  resolveMovePreviewOverlayEvent,
  resolveCalendarEventInteraction,
  resolveTimedToAllDaySpanDaysForDrag,
} from "./calendar-event-interaction";

describe("calendar event interaction", () => {
  test("fast move activates and resolves preview from pointer-up coordinates", () => {
    const resolved = resolveCalendarEventInteraction({
      eventId: "event-1",
      mode: "move",
      originDayIndex: 0,
      originRange: { startSlot: 20, endSlot: 23 },
      pointerStartX: 10,
      pointerStartY: 10,
      pointerX: 210,
      pointerY: 20,
      activationDistance: 6,
      wasActivated: false,
      grabOffsetSlots: 1,
      gridPosition: { dayIndex: 2, slot: 40 },
    });

    expect(resolved.activated).toBeTrue();
    expect(JSON.stringify(resolved.preview)).toBe(
      JSON.stringify({
        eventId: "event-1",
        dayIndex: 2,
        range: { startSlot: 39, endSlot: 42 },
      }),
    );
  });

  test("small move below threshold stays unactivated and has no preview", () => {
    const resolved = resolveCalendarEventInteraction({
      eventId: "event-1",
      mode: "move",
      originDayIndex: 0,
      originRange: { startSlot: 20, endSlot: 23 },
      pointerStartX: 10,
      pointerStartY: 10,
      pointerX: 14,
      pointerY: 13,
      activationDistance: 6,
      wasActivated: false,
      grabOffsetSlots: 1,
      gridPosition: { dayIndex: 2, slot: 40 },
    });

    expect(resolved.activated).toBeFalse();
    expect(resolved.preview).toBe(null);
  });

  test("resize-start and resize-end update only the selected edge", () => {
    const startResolved = resolveCalendarEventInteraction({
      eventId: "event-1",
      mode: "resize-start",
      originDayIndex: 1,
      originRange: { startSlot: 40, endSlot: 44 },
      pointerStartX: 0,
      pointerStartY: 0,
      pointerX: 0,
      pointerY: 0,
      activationDistance: 6,
      wasActivated: true,
      grabOffsetSlots: 0,
      gridPosition: { dayIndex: 1, slot: 42 },
    });
    const endResolved = resolveCalendarEventInteraction({
      eventId: "event-1",
      mode: "resize-end",
      originDayIndex: 1,
      originRange: { startSlot: 40, endSlot: 44 },
      pointerStartX: 0,
      pointerStartY: 0,
      pointerX: 0,
      pointerY: 0,
      activationDistance: 6,
      wasActivated: true,
      grabOffsetSlots: 0,
      gridPosition: { dayIndex: 1, slot: 43 },
    });

    expect(startResolved.activated).toBeTrue();
    expect(JSON.stringify(startResolved.preview)).toBe(
      JSON.stringify({
        eventId: "event-1",
        dayIndex: 1,
        range: { startSlot: 42, endSlot: 44 },
      }),
    );

    expect(endResolved.activated).toBeTrue();
    expect(JSON.stringify(endResolved.preview)).toBe(
      JSON.stringify({
        eventId: "event-1",
        dayIndex: 1,
        range: { startSlot: 40, endSlot: 43 },
      }),
    );
  });

  test("move preview clamps to end of day while preserving duration", () => {
    const resolved = resolveCalendarEventInteraction({
      eventId: "event-1",
      mode: "move",
      originDayIndex: 0,
      originRange: { startSlot: 40, endSlot: 43 },
      pointerStartX: 10,
      pointerStartY: 10,
      pointerX: 200,
      pointerY: 10,
      activationDistance: 6,
      wasActivated: false,
      grabOffsetSlots: 1,
      gridPosition: { dayIndex: 0, slot: 95 },
    });

    expect(resolved.activated).toBeTrue();
    expect(JSON.stringify(resolved.preview?.range)).toBe(
      JSON.stringify({ startSlot: 92, endSlot: 95 }),
    );
  });

  test("preview equality compares structural value", () => {
    const left = {
      eventId: "event-1",
      dayIndex: 2,
      range: { startSlot: 39, endSlot: 42 },
    };
    const right = {
      eventId: "event-1",
      dayIndex: 2,
      range: { startSlot: 39, endSlot: 42 },
    };

    expect(areCalendarEventPreviewsEqual(left, right)).toBeTrue();
    expect(
      areCalendarEventPreviewsEqual(left, {
        ...right,
        range: { startSlot: 39, endSlot: 43 },
      }),
    ).toBeFalse();
  });

  test("move drag preview freezes lane-driving schedule updates", () => {
    const cards = [
      {
        id: "event-1",
        scheduledStart: new Date(2026, 1, 14, 9, 0),
        scheduledEnd: new Date(2026, 1, 14, 10, 0),
      },
      {
        id: "event-2",
        scheduledStart: new Date(2026, 1, 14, 9, 30),
        scheduledEnd: new Date(2026, 1, 14, 10, 30),
      },
    ];
    const preview = {
      eventId: "event-1",
      dayIndex: 0,
      range: { startSlot: 44, endSlot: 47 },
    };
    const visibleDays = [new Date(2026, 1, 14)];

    const frozen = applyPreviewToScheduledEvents(cards, preview, visibleDays, {
      freezeLayout: true,
    });
    const moved = applyPreviewToScheduledEvents(cards, preview, visibleDays, {
      freezeLayout: false,
    });

    expect(frozen[0].scheduledStart.getHours()).toBe(9);
    expect(frozen[0].scheduledStart.getMinutes()).toBe(0);
    expect(moved[0].scheduledStart.getHours()).toBe(11);
    expect(moved[0].scheduledStart.getMinutes()).toBe(0);
  });

  test("move drag preview overlay resolves to preview range while source remains", () => {
    const cards = [
      {
        id: "event-1",
        scheduledStart: new Date(2026, 1, 14, 9, 0),
        scheduledEnd: new Date(2026, 1, 14, 10, 0),
      },
    ];
    const preview = {
      eventId: "event-1",
      dayIndex: 0,
      range: { startSlot: 44, endSlot: 47 },
    };
    const visibleDays = [new Date(2026, 1, 14)];
    const byId = new Map(cards.map((card) => [card.id, card]));

    expect(
      isMoveDragPreviewActive(
        { eventId: "event-1", mode: "move" },
        preview,
      ),
    ).toBeTrue();

    const overlay = resolveMovePreviewOverlayEvent(byId, preview, visibleDays, {
      isMovePreviewActive: true,
    });

    expect(overlay).not.toBeNull();
    expect(overlay?.scheduledStart.getHours()).toBe(11);
    expect(overlay?.scheduledStart.getMinutes()).toBe(0);
    expect(cards[0].scheduledStart.getHours()).toBe(9);
    expect(cards[0].scheduledStart.getMinutes()).toBe(0);
  });

  test("timed-to-all-day drag conversion resolves span days from duration", () => {
    expect(resolveTimedToAllDaySpanDaysForDrag(30 * 60 * 1000)).toBe(1);
    expect(resolveTimedToAllDaySpanDaysForDrag(49 * 60 * 60 * 1000)).toBe(3);
  });

  test("all-day-to-timed drag conversion uses 1h fallback for full-day durations", () => {
    expect(resolveAllDayToTimedDurationMsForDrag(24 * 60 * 60 * 1000)).toBe(60 * 60 * 1000);
    expect(resolveAllDayToTimedDurationMsForDrag(45 * 60 * 1000)).toBe(45 * 60 * 1000);
  });
});
