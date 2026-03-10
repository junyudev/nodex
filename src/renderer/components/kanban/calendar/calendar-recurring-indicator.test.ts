import { describe, expect, test } from "bun:test";

import {
  resolveRecurringIndicatorType,
  resolveRecurringIndicatorVariant,
} from "./calendar-recurring-indicator";

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
