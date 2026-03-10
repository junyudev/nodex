import { describe, expect, test } from "bun:test";
import {
  getVisibleDays,
  snapToSlot,
  timeToY,
  yToTime,
  slotToTime,
  slotRangeFromDates,
  slotRangeToDates,
  moveSlotRange,
  resizeSlotRange,
  formatHour,
  isSameDay,
  groupOverlapping,
  HOUR_HEIGHT,
  MIN_HOUR_HEIGHT,
  resolveShiftWheelDelta,
  resolveHourHeight,
  resolveTimelineViewportHeight,
  resolveNowY,
  SLOT_MINUTES,
  resolveShiftWheelDirection,
} from "./calendar-utils";

describe("getVisibleDays", () => {
  test("returns correct number of days", () => {
    const days = getVisibleDays(new Date(2026, 1, 14), 4);
    expect(days.length).toBe(4);
  });

  test("7-day view is rolling from the anchor date", () => {
    const days = getVisibleDays(new Date(2026, 1, 14), 7);
    expect(days.length).toBe(7);
    expect(days[0].getDate()).toBe(14);
    expect(days[6].getDate()).toBe(20);
  });

  test("advancing anchor by one day shifts 7-day window by one day", () => {
    const first = getVisibleDays(new Date(2026, 1, 14), 7);
    const second = getVisibleDays(new Date(2026, 1, 15), 7);

    expect(second[0].getTime() - first[0].getTime()).toBe(24 * 60 * 60 * 1000);
  });

  test("4-day view starts from anchor date", () => {
    const anchor = new Date(2026, 1, 14);
    const days = getVisibleDays(anchor, 4);
    expect(days[0].getDate()).toBe(14);
    expect(days[3].getDate()).toBe(17);
  });
});

describe("snapToSlot", () => {
  const slotHeight = HOUR_HEIGHT / (60 / SLOT_MINUTES); // 15px per 15-min slot

  test("snaps to correct slot", () => {
    expect(snapToSlot(0)).toBe(0);
    expect(snapToSlot(slotHeight - 1)).toBe(0);
    expect(snapToSlot(slotHeight)).toBe(1);
    expect(snapToSlot(slotHeight * 4)).toBe(4); // 1 hour mark
  });

  test("clamps to valid range", () => {
    expect(snapToSlot(-10)).toBe(0);
    expect(snapToSlot(99999)).toBe(95); // last slot (23:45)
  });

  test("supports dynamic hour height", () => {
    // 32px/hour => 8px per 15-min slot
    expect(snapToSlot(7, 32)).toBe(0);
    expect(snapToSlot(8, 32)).toBe(1);
    expect(snapToSlot(32, 32)).toBe(4);
  });
});

describe("timeToY / yToTime roundtrip", () => {
  test("9:00 AM", () => {
    const y = timeToY(9, 0);
    expect(y).toBe(9 * HOUR_HEIGHT);
    const time = yToTime(y);
    expect(time.hour).toBe(9);
    expect(time.minute).toBe(0);
  });

  test("14:30", () => {
    const y = timeToY(14, 30);
    expect(y).toBe(14 * HOUR_HEIGHT + 30);
    const time = yToTime(y);
    expect(time.hour).toBe(14);
    expect(time.minute).toBe(30);
  });

  test("supports dynamic hour height", () => {
    const y = timeToY(9, 30, 32);
    expect(y).toBe(304);
    const time = yToTime(y, 32);
    expect(time.hour).toBe(9);
    expect(time.minute).toBe(30);
  });
});

describe("resolveNowY", () => {
  test("uses sub-minute precision for current time position", () => {
    const now = new Date(2026, 1, 14, 9, 30, 30, 500);
    const expected = 570.5083333333333;
    const actual = resolveNowY(now);
    expect(Math.abs(actual - expected) < 1e-9).toBeTrue();
  });

  test("falls back to default hour height for invalid inputs", () => {
    const now = new Date(2026, 1, 14, 1, 0, 0, 0);
    expect(resolveNowY(now, Number.NaN)).toBe(60);
  });
});

describe("resolveHourHeight", () => {
  test("fits timeline to available height when above minimum", () => {
    expect(resolveHourHeight(24 * 40)).toBe(40);
  });

  test("enforces minimum hour height", () => {
    expect(resolveHourHeight(24 * 20)).toBe(MIN_HOUR_HEIGHT);
  });

  test("falls back to default for invalid measurements", () => {
    expect(resolveHourHeight(0)).toBe(HOUR_HEIGHT);
    expect(resolveHourHeight(Number.NaN)).toBe(HOUR_HEIGHT);
  });
});

describe("resolveTimelineViewportHeight", () => {
  test("subtracts chrome heights from panel height", () => {
    expect(
      resolveTimelineViewportHeight({
        panelHeight: 720,
        headerHeight: 48,
        allDayLaneHeight: 72,
        separatorHeight: 1,
      }),
    ).toBe(599);
  });

  test("clamps to 0 when chrome exceeds panel", () => {
    expect(
      resolveTimelineViewportHeight({
        panelHeight: 90,
        headerHeight: 48,
        allDayLaneHeight: 72,
        separatorHeight: 1,
      }),
    ).toBe(0);
  });
});

describe("resolveShiftWheelDelta", () => {
  test("returns 0 when shift is not pressed", () => {
    const delta = resolveShiftWheelDelta({
      shiftKey: false,
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
      pageHeight: 600,
    });
    expect(delta).toBe(0);
  });

  test("uses deltaY for shift+vertical-wheel in pixel mode", () => {
    const delta = resolveShiftWheelDelta({
      shiftKey: true,
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
      pageHeight: 600,
    });
    expect(delta).toBe(120);
  });

  test("prefers deltaX when present", () => {
    const delta = resolveShiftWheelDelta({
      shiftKey: true,
      deltaX: 40,
      deltaY: 120,
      deltaMode: 0,
      pageHeight: 600,
    });
    expect(delta).toBe(40);
  });

  test("normalizes line and page delta modes", () => {
    const lineDelta = resolveShiftWheelDelta({
      shiftKey: true,
      deltaX: 0,
      deltaY: 3,
      deltaMode: 1,
      pageHeight: 600,
    });
    expect(lineDelta).toBe(48);

    const pageDelta = resolveShiftWheelDelta({
      shiftKey: true,
      deltaX: 0,
      deltaY: 1,
      deltaMode: 2,
      pageHeight: 600,
    });
    expect(pageDelta).toBe(600);
  });
});

describe("resolveShiftWheelDirection", () => {
  test("returns 0 when ctrl/meta modifier is pressed", () => {
    const direction = resolveShiftWheelDirection({
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      deltaX: 120,
      deltaY: 0,
      deltaMode: 0,
      pageHeight: 600,
    });
    expect(direction).toBe(0);
  });

  test("returns next direction for positive shift wheel delta", () => {
    const direction = resolveShiftWheelDirection({
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
      pageHeight: 600,
    });
    expect(direction).toBe(1);
  });

  test("returns previous direction for negative shift wheel delta", () => {
    const direction = resolveShiftWheelDirection({
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      deltaX: -120,
      deltaY: 0,
      deltaMode: 0,
      pageHeight: 600,
    });
    expect(direction).toBe(-1);
  });
});

describe("slotToTime", () => {
  test("slot 0 is midnight", () => {
    const t = slotToTime(0);
    expect(t.hour).toBe(0);
    expect(t.minute).toBe(0);
  });

  test("slot 4 is 1:00 AM", () => {
    const t = slotToTime(4);
    expect(t.hour).toBe(1);
    expect(t.minute).toBe(0);
  });

  test("slot 36 is 9:00 AM", () => {
    const t = slotToTime(36);
    expect(t.hour).toBe(9);
    expect(t.minute).toBe(0);
  });
});

describe("slot range helpers", () => {
  test("slotRangeFromDates rounds start down and end up to slot boundaries", () => {
    const start = new Date(2026, 1, 14, 9, 7);
    const end = new Date(2026, 1, 14, 10, 2);
    const range = slotRangeFromDates(start, end);
    expect(range.startSlot).toBe(36);
    expect(range.endSlot).toBe(40);
  });

  test("slotRangeFromDates handles end-of-day ranges", () => {
    const start = new Date(2026, 1, 14, 23, 45);
    const end = new Date(2026, 1, 15, 0, 0);
    const range = slotRangeFromDates(start, end);
    expect(range.startSlot).toBe(95);
    expect(range.endSlot).toBe(95);
  });

  test("slotRangeToDates converts slots back to exact datetime range", () => {
    const day = new Date(2026, 1, 14);
    const { start, end } = slotRangeToDates(day, { startSlot: 36, endSlot: 39 });
    expect(start.getHours()).toBe(9);
    expect(start.getMinutes()).toBe(0);
    expect(end.getHours()).toBe(10);
    expect(end.getMinutes()).toBe(0);
  });

  test("slotRangeToDates preserves final 15-minute slot duration", () => {
    const day = new Date(2026, 1, 14);
    const { start, end } = slotRangeToDates(day, { startSlot: 95, endSlot: 95 });
    expect((end.getTime() - start.getTime()) / 60000).toBe(15);
  });

  test("moveSlotRange keeps duration and clamps within day", () => {
    const moved = moveSlotRange({ startSlot: 40, endSlot: 43 }, 95, 1);
    expect(moved.startSlot).toBe(92);
    expect(moved.endSlot).toBe(95);
  });

  test("resizeSlotRange adjusts only the selected edge", () => {
    const fromStart = resizeSlotRange({ startSlot: 40, endSlot: 44 }, 42, "start");
    expect(fromStart.startSlot).toBe(42);
    expect(fromStart.endSlot).toBe(44);

    const fromEnd = resizeSlotRange({ startSlot: 40, endSlot: 44 }, 43, "end");
    expect(fromEnd.startSlot).toBe(40);
    expect(fromEnd.endSlot).toBe(43);
  });
});

describe("formatHour", () => {
  test("formats correctly", () => {
    expect(formatHour(0)).toBe("12 AM");
    expect(formatHour(1)).toBe("1 AM");
    expect(formatHour(12)).toBe("12 PM");
    expect(formatHour(13)).toBe("1 PM");
    expect(formatHour(23)).toBe("11 PM");
  });
});

describe("isSameDay", () => {
  test("same day returns true", () => {
    expect(isSameDay(new Date(2026, 1, 14, 9, 0), new Date(2026, 1, 14, 17, 0))).toBe(true);
  });

  test("different day returns false", () => {
    expect(isSameDay(new Date(2026, 1, 14), new Date(2026, 1, 15))).toBe(false);
  });
});

describe("groupOverlapping", () => {
  function makeEvent(id: string, startH: number, endH: number) {
    return {
      id,
      scheduledStart: new Date(2026, 1, 14, startH, 0),
      scheduledEnd: new Date(2026, 1, 14, endH, 0),
    };
  }

  test("non-overlapping events get lane 0", () => {
    const events = [makeEvent("a", 9, 10), makeEvent("b", 11, 12)];
    const result = groupOverlapping(events);
    expect(result.every((e) => e.lane === 0)).toBe(true);
    expect(result.every((e) => e.totalLanes === 1)).toBe(true);
  });

  test("two overlapping events get separate lanes", () => {
    const events = [makeEvent("a", 9, 11), makeEvent("b", 10, 12)];
    const result = groupOverlapping(events);
    expect(result[0].lane).toBe(0);
    expect(result[1].lane).toBe(1);
    expect(result[0].totalLanes).toBe(2);
    expect(result[1].totalLanes).toBe(2);
  });

  test("three overlapping events", () => {
    const events = [makeEvent("a", 9, 11), makeEvent("b", 10, 12), makeEvent("c", 10, 11)];
    const result = groupOverlapping(events);
    const lanes = new Set(result.map((e) => e.lane));
    expect(lanes.size).toBe(3);
  });

  test("chain overlap uses peak simultaneous lanes, not transitive group size", () => {
    const events = [makeEvent("a", 9, 11), makeEvent("b", 10, 12), makeEvent("c", 11, 13)];
    const result = groupOverlapping(events);

    const byId = new Map(result.map((event) => [event.id, event]));
    expect(byId.get("a")?.lane).toBe(0);
    expect(byId.get("b")?.lane).toBe(1);
    expect(byId.get("c")?.lane).toBe(0);
    expect(result.every((event) => event.totalLanes === 2)).toBe(true);
  });

  test("non-overlapping chains remain independent lane components", () => {
    const events = [
      makeEvent("a", 9, 10),
      makeEvent("b", 9, 10),
      makeEvent("c", 12, 13),
      makeEvent("d", 12, 13),
    ];
    const result = groupOverlapping(events);
    const byId = new Map(result.map((event) => [event.id, event]));

    expect(byId.get("a")?.totalLanes).toBe(2);
    expect(byId.get("b")?.totalLanes).toBe(2);
    expect(byId.get("c")?.totalLanes).toBe(2);
    expect(byId.get("d")?.totalLanes).toBe(2);
  });

  test("empty array returns empty", () => {
    const result = groupOverlapping([]);
    expect(result.length).toBe(0);
  });
});
