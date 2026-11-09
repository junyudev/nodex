import { describe, expect, test } from "vite-plus/test";
import { formatAutomationRruleSummary } from "./automation-display";

describe("codex clock Automation display", () => {
  test("formats calendar RRULE strings with DTSTART lines", () => {
    expect(
      formatAutomationRruleSummary("DTSTART;TZID=Asia/Shanghai:20260710T090000\nRRULE:FREQ=DAILY"),
    ).toBe("Daily");
  });
});
