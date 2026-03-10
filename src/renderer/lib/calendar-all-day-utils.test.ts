import { describe, expect, test } from "bun:test";
import {
  buildAllDaySegments,
  packAllDaySegments,
  resolveAllDaySpanDays,
  resolveAllDayToTimedDurationMs,
  resolveTimedToAllDaySpanDays,
  toAllDayRangeFromTimedDrop,
} from "./calendar-all-day-utils";

describe("calendar all-day utils", () => {
  test("resolves all-day span from end-exclusive range", () => {
    expect(
      resolveAllDaySpanDays(
        new Date("2026-03-10T00:00:00.000Z"),
        new Date("2026-03-13T00:00:00.000Z"),
      ),
    ).toBe(3);
  });

  test("converts timed duration into day span", () => {
    expect(resolveTimedToAllDaySpanDays(30 * 60 * 1000)).toBe(1);
    expect(resolveTimedToAllDaySpanDays(26 * 60 * 60 * 1000)).toBe(2);
  });

  test("all-day to timed uses 1h fallback for full-day durations", () => {
    expect(resolveAllDayToTimedDurationMs(24 * 60 * 60 * 1000)).toBe(60 * 60 * 1000);
    expect(resolveAllDayToTimedDurationMs(45 * 60 * 1000)).toBe(45 * 60 * 1000);
  });

  test("builds all-day segments clipped to visible window", () => {
    const visibleDays = [
      new Date("2026-03-10T00:00:00.000Z"),
      new Date("2026-03-11T00:00:00.000Z"),
      new Date("2026-03-12T00:00:00.000Z"),
      new Date("2026-03-13T00:00:00.000Z"),
    ];
    const segments = buildAllDaySegments(
      [
        {
          id: "a",
          scheduledStart: new Date("2026-03-09T00:00:00.000Z"),
          scheduledEnd: new Date("2026-03-11T00:00:00.000Z"),
        },
        {
          id: "b",
          scheduledStart: new Date("2026-03-11T00:00:00.000Z"),
          scheduledEnd: new Date("2026-03-14T00:00:00.000Z"),
        },
      ],
      visibleDays,
    );

    expect(segments.length).toBe(2);
    expect(segments[0]?.startDayIndex).toBe(0);
    expect(segments[0]?.endDayIndex).toBe(1);
    expect(segments[1]?.startDayIndex).toBe(1);
    expect(segments[1]?.endDayIndex).toBe(4);
  });

  test("packs overlapping all-day segments into lanes", () => {
    const packed = packAllDaySegments([
      { event: { id: "a", scheduledStart: new Date(), scheduledEnd: new Date() }, startDayIndex: 0, endDayIndex: 3 },
      { event: { id: "b", scheduledStart: new Date(), scheduledEnd: new Date() }, startDayIndex: 1, endDayIndex: 2 },
      { event: { id: "c", scheduledStart: new Date(), scheduledEnd: new Date() }, startDayIndex: 3, endDayIndex: 4 },
    ]);

    const byId = new Map(packed.map((item) => [item.event.id, item]));
    expect(byId.get("a")?.lane).toBe(0);
    expect(byId.get("b")?.lane).toBe(1);
    expect(byId.get("c")?.lane).toBe(0);
  });

  test("creates all-day drop range from timed duration", () => {
    const range = toAllDayRangeFromTimedDrop(
      new Date("2026-03-10T16:00:00.000Z"),
      36 * 60 * 60 * 1000,
    );

    expect(range.start.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-03-12T00:00:00.000Z");
  });
});

