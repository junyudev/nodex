import { expect, test } from "vite-plus/test";
import { formatCompactRelativeTime } from "./compact-relative-time";

test("formats elapsed time compactly at each unit boundary", () => {
  expect(formatCompactRelativeTime(0, 59_999)).toBe("now");
  expect(formatCompactRelativeTime(0, 60_000)).toBe("1m");
  expect(formatCompactRelativeTime(0, 5 * 60_000)).toBe("5m");
  expect(formatCompactRelativeTime(0, 3 * 3_600_000)).toBe("3h");
  expect(formatCompactRelativeTime(0, 2 * 86_400_000)).toBe("2d");
  expect(formatCompactRelativeTime(0, 7 * 86_400_000)).toBe("1w");
  expect(formatCompactRelativeTime(0, 29 * 86_400_000)).toBe("4w");
  expect(formatCompactRelativeTime(10, 0)).toBe("now");
  expect(formatCompactRelativeTime(Number.NaN, 0)).toBe("");
});

test("falls back to a short date after thirty days", () => {
  const timestamp = Date.UTC(2026, 0, 15, 12);
  expect(formatCompactRelativeTime(timestamp, timestamp + 31 * 86_400_000)).toBe(
    new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  );
});
