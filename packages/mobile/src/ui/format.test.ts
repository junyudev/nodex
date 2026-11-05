import { describe, expect, it } from "vitest";

import { formatAge, formatStreamTime } from "./format";

const now = new Date(2026, 10, 4, 18, 30).getTime();

describe("formatAge", () => {
  it.each([
    [now - 5_000, "now"],
    [now - 59_000, "now"],
    [now - 60_000, "1m"],
    [now - 59 * 60_000, "59m"],
    [now - 60 * 60_000, "1h"],
    [now - 23 * 3_600_000, "23h"],
  ])("reads recent times as an age", (at, expected) => {
    expect(formatAge(at, now)).toBe(expected);
  });

  it("names the weekday within a week, then the date, and the year only when it differs", () => {
    expect(formatAge(new Date(2026, 10, 2, 9, 0).getTime(), now)).toBe("Mon");
    expect(formatAge(new Date(2026, 9, 12, 9, 0).getTime(), now)).toBe("Oct 12");
    expect(formatAge(new Date(2025, 9, 12, 9, 0).getTime(), now)).toBe("Oct 12, 2025");
  });
});

describe("formatStreamTime", () => {
  it("shows only the clock for today", () => {
    expect(formatStreamTime(new Date(2026, 10, 4, 9, 5).getTime(), now)).toBe("9:05");
  });

  it("adds the date otherwise", () => {
    expect(formatStreamTime(new Date(2026, 10, 3, 23, 40).getTime(), now)).toBe("Nov 3, 23:40");
  });
});
