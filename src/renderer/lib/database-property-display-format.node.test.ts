import { describe, expect, test } from "vite-plus/test";

import { formatDatabaseDate, formatDatabaseNumber } from "./database-property-display-format";

describe("Database Property display formats", () => {
  test("formats finite number modes without changing stored values", () => {
    expect(formatDatabaseNumber(0.25, { kind: "percent" }, "en-US")).toBe("25%");
    expect(formatDatabaseNumber(12.5, { kind: "currency", currencyCode: "usd" }, "en-US")).toBe(
      "$12.50",
    );
    expect(formatDatabaseNumber(1_200.5, { kind: "plain" }, "en-US")).toBe("1,200.5");
  });

  test("formats date order, relative dates, and explicit 24-hour time", () => {
    const date = new Date(2026, 7, 29, 17, 5);
    expect(formatDatabaseDate({ date, dateFormat: "year_month_day", locale: "en-US" })).toBe(
      "2026-08-29",
    );
    expect(
      formatDatabaseDate({
        date,
        dateFormat: "relative",
        now: new Date(2026, 7, 28),
      }),
    ).toBe("Tomorrow");
    expect(
      formatDatabaseDate({
        date,
        dateFormat: "year_month_day",
        timeFormat: "twenty_four_hour",
        locale: "en-US",
      }),
    ).toContain("17:05");
  });
});
