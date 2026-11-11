import { describe, expect, it } from "vitest";

import { formatLaterTime, inboxLaterPresets } from "./inbox-later-time";

const local = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 10, day, hour, minute, second);
const clock = (date: Date) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
const weekday = (date: Date) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);

describe("Inbox Later choices", () => {
  it("rounds delays up to the minute and uses local morning and the following Monday", () => {
    const morning = local(4, 9);
    const monday = local(9, 9);
    expect(inboxLaterPresets(local(4, 2, 13, 42))).toEqual([
      { label: "In 1 hour", remindAt: local(4, 3, 14).toISOString() },
      { label: "In 3 hours", remindAt: local(4, 5, 14).toISOString() },
      { label: `This morning, ${clock(morning)}`, remindAt: morning.toISOString() },
      { label: `Next week, ${weekday(monday)} ${clock(monday)}`, remindAt: monday.toISOString() },
    ]);
  });

  it("drops the morning at exactly three hours if the three-hour choice already covers it", () => {
    const choices = inboxLaterPresets(local(4, 6));
    expect(choices.map(({ remindAt }) => remindAt)).toEqual([
      local(4, 7).toISOString(),
      local(4, 9).toISOString(),
      local(9, 9).toISOString(),
    ]);
    expect(choices[1]?.label).toBe("In 3 hours");
  });

  it("uses tomorrow when today is less than three hours away", () => {
    const tomorrow = local(5, 9);
    expect(inboxLaterPresets(local(4, 6, 0, 1))[2]).toEqual({
      label: `Tomorrow, ${clock(tomorrow)}`,
      remindAt: tomorrow.toISOString(),
    });
  });

  it("drops next week on Sunday when it matches tomorrow and uses the next Monday on Monday", () => {
    const monday = local(9, 9);
    const sunday = inboxLaterPresets(local(8, 11));
    expect(sunday.slice(2)).toEqual([
      { label: `Tomorrow, ${clock(monday)}`, remindAt: monday.toISOString() },
    ]);
    expect(inboxLaterPresets(local(9, 11))[3]?.remindAt).toBe(local(16, 9).toISOString());
  });
});

it("shows tomorrow and someday as return times", () => {
  const tomorrow = local(5, 9);
  expect(formatLaterTime(tomorrow.toISOString(), local(4, 23))).toBe(
    `Tomorrow, ${clock(tomorrow)}`,
  );
});
