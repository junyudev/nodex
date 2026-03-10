import { describe, expect, test } from "bun:test";

import {
  resolveCalendarMoveDropSchedule,
  resolveCalendarMovePreview,
  type CalendarMoveDragSession,
} from "./calendar-event-move-drag";

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
    expect(schedule?.isAllDay).toBeFalse();
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
    expect(schedule?.isAllDay).toBeTrue();
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
