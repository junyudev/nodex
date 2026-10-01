import { describe, expect, test } from "vite-plus/test";
import type { NfmDateMentionInlineContent } from "./types";
import {
  buildDateMentionQueryMatches,
  formatDateMentionDisplay,
  formatDateMentionPlainText,
} from "./date-mention";

const now = new Date(2026, 9, 1, 16, 53);
const datetime: NfmDateMentionInlineContent = {
  type: "dateMention",
  start: "2026-10-01T16:53:00+08:00",
  format: "relative",
  timeFormat: "12h",
};

describe("date mention labels", () => {
  test.each([
    ["12h", "@4:53 PM"],
    ["24h", "@16:53"],
  ] as const)("omits Today for a datetime in %s format", (timeFormat, expected) => {
    expect(formatDateMentionDisplay({ ...datetime, timeFormat }, { now })).toBe(expected);
  });

  test("formats the Now suggestion as a time while Today remains a date", () => {
    const nowMatch = buildDateMentionQueryMatches("now", now).find(
      (match) => match.key === "date:now",
    );
    expect(nowMatch).toBeDefined();
    expect(formatDateMentionDisplay(nowMatch?.payload, { now })).toBe("@4:53 PM");
    expect(formatDateMentionDisplay({ ...datetime, start: "2026-10-01" }, { now })).toBe("@Today");
  });

  test.each([
    ["2026-09-30T16:53:00+08:00", "@Yesterday 4:53 PM"],
    ["2026-10-02T16:53:00+08:00", "@Tomorrow 4:53 PM"],
  ])("retains the date for %s", (start, expected) => {
    expect(formatDateMentionDisplay({ ...datetime, start }, { now })).toBe(expected);
  });

  test.each([
    ["ll", "@Oct 1, 2026 4:53 PM"],
    ["YYYY/MM/DD", "@2026/10/01 4:53 PM"],
  ] as const)("preserves the explicit %s date format", (format, expected) => {
    expect(formatDateMentionDisplay({ ...datetime, format }, { now })).toBe(expected);
  });

  test.each([
    ["2026-10-01T16:53:00+08:00", "2026-10-01T18:00:00+08:00", "@4:53 PM → 6:00 PM"],
    ["2026-10-01T16:53:00+08:00", "2026-10-02T18:00:00+08:00", "@4:53 PM → Tomorrow 6:00 PM"],
    ["2026-09-30T16:53:00+08:00", "2026-10-01T18:00:00+08:00", "@Yesterday 4:53 PM → 6:00 PM"],
  ])("formats range endpoints independently", (start, end, expected) => {
    expect(formatDateMentionDisplay({ ...datetime, start, end }, { now })).toBe(expected);
  });

  test("keeps full dates in plain text regardless of the current day", () => {
    expect(formatDateMentionPlainText(datetime, { now })).toBe("@Oct 1, 2026 4:53 PM");
    expect(formatDateMentionPlainText(datetime, { now: new Date(2026, 9, 2) })).toBe(
      "@Oct 1, 2026 4:53 PM",
    );
  });
});
