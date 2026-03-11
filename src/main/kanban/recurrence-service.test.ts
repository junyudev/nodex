import { describe, expect, test } from "bun:test";

import type { Card, ReminderConfig } from "../../shared/types";
import {
  expandCardOccurrences,
  nextOccurrenceAfter,
  shiftUntilDateByDays,
  type RecurrenceException,
} from "./recurrence-service";

function createScheduledCard(overrides: Partial<Card>): Card {
  return {
    id: "card-1",
    status: "draft",
    archived: false,
    title: "Recurring task",
    description: "",
    priority: "p2-medium",
    tags: [],
    agentBlocked: false,
    revision: 1,
    created: new Date("2026-02-18T09:00:00.000Z"),
    order: 1,
    scheduledStart: new Date("2026-02-18T10:00:00.000Z"),
    scheduledEnd: new Date("2026-02-18T11:00:00.000Z"),
    recurrence: {
      frequency: "daily",
      interval: 1,
      endCondition: { type: "never" },
    },
    reminders: [{ offsetMinutes: 10 }],
    scheduleTimezone: "UTC",
    ...overrides,
  };
}

function dateKeyInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

describe("recurrence service", () => {
  test("expands daily recurrence with inclusive until date", () => {
    const card = createScheduledCard({
      recurrence: {
        frequency: "daily",
        interval: 1,
        endCondition: { type: "untilDate", untilDate: "2026-02-20" },
      },
    });

    const occurrences = expandCardOccurrences(
      card,
      new Date("2026-02-18T00:00:00.000Z"),
      new Date("2026-02-22T00:00:00.000Z"),
    );

    expect(JSON.stringify(occurrences.map((entry) => entry.occurrenceStart.toISOString()))).toBe(
      JSON.stringify([
        "2026-02-18T10:00:00.000Z",
        "2026-02-19T10:00:00.000Z",
        "2026-02-20T10:00:00.000Z",
      ]),
    );
  });

  test("expands weekly recurrence using selected weekdays", () => {
    const card = createScheduledCard({
      recurrence: {
        frequency: "weekly",
        interval: 1,
        byWeekdays: [2, 3],
        endCondition: { type: "never" },
      },
    });

    const occurrences = expandCardOccurrences(
      card,
      new Date("2026-02-16T00:00:00.000Z"),
      new Date("2026-02-27T00:00:00.000Z"),
    );

    expect(JSON.stringify(occurrences.map((entry) => entry.occurrenceStart.toISOString()))).toBe(
      JSON.stringify([
        "2026-02-18T10:00:00.000Z",
        "2026-02-24T10:00:00.000Z",
        "2026-02-25T10:00:00.000Z",
      ]),
    );
  });

  test("applies skip and override-time exceptions", () => {
    const overrideReminders: ReminderConfig[] = [{ offsetMinutes: 30 }];
    const exceptions: RecurrenceException[] = [
      {
        occurrenceStart: new Date("2026-02-19T10:00:00.000Z"),
        exceptionType: "skip",
      },
      {
        occurrenceStart: new Date("2026-02-20T10:00:00.000Z"),
        exceptionType: "override_time",
        overrideStart: new Date("2026-02-20T15:00:00.000Z"),
        overrideEnd: new Date("2026-02-20T16:00:00.000Z"),
        overrideReminders,
      },
    ];

    const occurrences = expandCardOccurrences(
      createScheduledCard({}),
      new Date("2026-02-18T00:00:00.000Z"),
      new Date("2026-02-22T00:00:00.000Z"),
      { exceptions },
    );

    expect(JSON.stringify(occurrences.map((entry) => entry.occurrenceStart.toISOString()))).toBe(
      JSON.stringify([
        "2026-02-18T10:00:00.000Z",
        "2026-02-20T15:00:00.000Z",
        "2026-02-21T10:00:00.000Z",
      ]),
    );
    expect(JSON.stringify(occurrences[1]?.reminders)).toBe(JSON.stringify(overrideReminders));
  });

  test("computes next occurrence after skipped exception", () => {
    const card = createScheduledCard({});
    const next = nextOccurrenceAfter(card, new Date("2026-02-18T10:00:00.000Z"), {
      exceptions: [{
        occurrenceStart: new Date("2026-02-19T10:00:00.000Z"),
        exceptionType: "skip",
      }],
    });

    expect(next?.occurrenceStart.toISOString()).toBe("2026-02-20T10:00:00.000Z");
  });

  test("shifts until date keys by whole days", () => {
    expect(shiftUntilDateByDays("2026-02-18", -1)).toBe("2026-02-17");
    expect(shiftUntilDateByDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  test("all-day recurrence keeps local midnight boundaries across DST transitions", () => {
    const timezone = "America/Los_Angeles";
    const card = createScheduledCard({
      isAllDay: true,
      scheduledStart: new Date("2026-03-07T08:00:00.000Z"), // Mar 7 00:00 PST
      scheduledEnd: new Date("2026-03-08T08:00:00.000Z"), // Mar 8 00:00 PST
      recurrence: {
        frequency: "daily",
        interval: 1,
        endCondition: { type: "untilDate", untilDate: "2026-03-10" },
      },
      scheduleTimezone: timezone,
    });

    const occurrences = expandCardOccurrences(
      card,
      new Date("2026-03-07T00:00:00.000Z"),
      new Date("2026-03-12T00:00:00.000Z"),
    );

    expect(occurrences.length).toBe(4);
    for (const occurrence of occurrences) {
      const startKey = dateKeyInTimezone(occurrence.occurrenceStart, timezone);
      const endKey = dateKeyInTimezone(occurrence.occurrenceEnd, timezone);
      const dayDiff = Math.round(
        (Date.parse(`${endKey}T00:00:00.000Z`) - Date.parse(`${startKey}T00:00:00.000Z`))
          / (24 * 60 * 60 * 1000),
      );
      expect(dayDiff).toBe(1);
    }
  });
});
