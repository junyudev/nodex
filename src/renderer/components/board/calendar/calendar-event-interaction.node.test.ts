import { describe, expect, test } from "vite-plus/test";
import {
  applyPreviewToScheduledEvents,
  areCalendarEventPreviewsEqual,
  isMoveDragPreviewActive,
  resolveAllDayToTimedDurationMsForDrag,
  resolveMovePreviewOverlayEvent,
  resolveCalendarEventInteraction,
  resolveTimedToAllDaySpanDaysForDrag,
} from "./calendar-event-interaction";
import {
  resolveCalendarMoveDropSchedule,
  resolveCalendarMovePreview,
  type CalendarMoveDragSession,
} from "./calendar-event-move-drag";
import {
  resolveRecurringIndicatorType,
  resolveRecurringIndicatorVariant,
} from "./calendar-recurring-indicator";
import { resolveOccurrenceScopeOptions } from "./occurrence-scope-options";

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

    expect(resolved.activated).toBe(true);
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

    expect(resolved.activated).toBe(false);
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

    expect(startResolved.activated).toBe(true);
    expect(JSON.stringify(startResolved.preview)).toBe(
      JSON.stringify({
        eventId: "event-1",
        dayIndex: 1,
        range: { startSlot: 42, endSlot: 44 },
      }),
    );

    expect(endResolved.activated).toBe(true);
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

    expect(resolved.activated).toBe(true);
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

    expect(areCalendarEventPreviewsEqual(left, right)).toBe(true);
    expect(
      areCalendarEventPreviewsEqual(left, {
        ...right,
        range: { startSlot: 39, endSlot: 43 },
      }),
    ).toBe(false);
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

    expect(isMoveDragPreviewActive({ eventId: "event-1", mode: "move" }, preview)).toBe(true);

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

describe("calendar event move drag", () => {
  const baseSession: CalendarMoveDragSession = {
    eventId: "event-1",
    originDayIndex: 0,
    originRange: { startSlot: 20, endSlot: 23 },
    originIsAllDay: false,
    originalDurationMs: 60 * 60 * 1000,
    originalAllDaySpanDays: 1,
    grabOffsetSlots: 1,
  };

  describe("calendar event move drag helpers", () => {
    test("resolves timed preview preserving source duration", () => {
      const preview = resolveCalendarMovePreview(baseSession, {
        region: "timed",
        dayIndex: 2,
        slot: 40,
      });

      expect(preview).not.toBeNull();
      expect(preview?.kind).toBe("timed");
      expect(preview && "range" in preview ? preview.range.startSlot : null).toBe(39);
      expect(preview && "range" in preview ? preview.range.endSlot : null).toBe(42);
    });

    test("resolves timed to all-day preview span from duration", () => {
      const preview = resolveCalendarMovePreview(
        {
          ...baseSession,
          originalDurationMs: 49 * 60 * 60 * 1000,
        },
        {
          region: "all-day",
          dayIndex: 1,
        },
      );

      expect(preview).not.toBeNull();
      expect(preview?.kind).toBe("all-day");
      expect(preview && "startDayIndex" in preview ? preview.startDayIndex : null).toBe(1);
      expect(preview && "endDayIndex" in preview ? preview.endDayIndex : null).toBe(4);
    });

    test("resolves all-day to timed drop with one-hour fallback duration", () => {
      const schedule = resolveCalendarMoveDropSchedule(
        {
          ...baseSession,
          originIsAllDay: true,
          originalDurationMs: 24 * 60 * 60 * 1000,
          originalAllDaySpanDays: 1,
        },
        {
          region: "timed",
          dayIndex: 0,
          slot: 32,
        },
        [new Date(2026, 1, 14)],
      );

      expect(schedule).not.toBeNull();
      expect(schedule?.isAllDay).toBe(false);
      expect(schedule?.start.getHours()).toBe(8);
      expect(schedule?.start.getMinutes()).toBe(0);
      expect(schedule?.end.getHours()).toBe(9);
      expect(schedule?.end.getMinutes()).toBe(0);
    });

    test("resolves all-day to all-day drop preserving span days", () => {
      const schedule = resolveCalendarMoveDropSchedule(
        {
          ...baseSession,
          originIsAllDay: true,
          originalDurationMs: 48 * 60 * 60 * 1000,
          originalAllDaySpanDays: 2,
        },
        {
          region: "all-day",
          dayIndex: 1,
        },
        [new Date(2026, 1, 14), new Date(2026, 1, 15), new Date(2026, 1, 16)],
      );

      expect(schedule).not.toBeNull();
      expect(schedule?.isAllDay).toBe(true);
      expect(schedule?.start.getDate()).toBe(15);
      expect(schedule?.end.getDate()).toBe(17);
    });

    test("returns null when drop target is outside visible day range", () => {
      const schedule = resolveCalendarMoveDropSchedule(
        baseSession,
        {
          region: "timed",
          dayIndex: 3,
          slot: 20,
        },
        [new Date(2026, 1, 14)],
      );

      expect(schedule).toBe(null);
    });
  });
});

describe("resolveRecurringIndicatorVariant", () => {
  test("returns none when event is not recurring", () => {
    expect(resolveRecurringIndicatorVariant(false, 15)).toBe("none");
    expect(resolveRecurringIndicatorVariant(false, 60)).toBe("none");
  });

  test("returns compact for short recurring events", () => {
    expect(resolveRecurringIndicatorVariant(true, 30)).toBe("compact");
    expect(resolveRecurringIndicatorVariant(true, 15)).toBe("compact");
  });

  test("returns badge for recurring events longer than 30 minutes", () => {
    expect(resolveRecurringIndicatorVariant(true, 31)).toBe("badge");
    expect(resolveRecurringIndicatorVariant(true, 120)).toBe("badge");
  });
});

describe("resolveRecurringIndicatorType", () => {
  test("returns none when event is not recurring", () => {
    expect(resolveRecurringIndicatorType(false, false)).toBe("none");
    expect(resolveRecurringIndicatorType(false, true)).toBe("none");
  });

  test("returns series-start for first recurring occurrence", () => {
    expect(resolveRecurringIndicatorType(true, true)).toBe("series-start");
  });

  test("returns recurring for non-first recurring occurrence", () => {
    expect(resolveRecurringIndicatorType(true, false)).toBe("recurring");
  });
});

describe("resolveOccurrenceScopeOptions", () => {
  test("shows only this and this-and-future on non-first recurring occurrences", () => {
    const options = resolveOccurrenceScopeOptions(false);
    expect(JSON.stringify(options.map((option) => option.scope))).toBe(
      JSON.stringify(["this", "this-and-future"]),
    );
    expect(options[1]?.isPrimary).toBe(true);
  });

  test("shows only this and all on first recurring occurrence", () => {
    const options = resolveOccurrenceScopeOptions(true);
    expect(JSON.stringify(options.map((option) => option.scope))).toBe(
      JSON.stringify(["this", "all"]),
    );
    expect(options[1]?.label).toBe("All occurrences");
  });
});
