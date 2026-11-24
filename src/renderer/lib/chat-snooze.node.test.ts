import { describe, expect, it } from "vitest";
import {
  chatSnoozePresetTime,
  chatSnoozePresets,
  defaultCustomSnoozeInput,
  minimumCustomSnoozeInput,
  parseCustomSnoozeInput,
  describeChatSnooze,
  describeChatSnoozeAbsolute,
  formatChatSnoozeConfirmation,
  formatChatSnoozeTime,
} from "./chat-snooze";

const local = (y: number, m: number, d: number, h: number, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s);
const presetTimes = (now: Date) =>
  Object.fromEntries(chatSnoozePresets(now, "en-US").map((p) => [p.id, new Date(p.snoozedUntil)]));

describe("chatSnoozePresets", () => {
  it("offers an hour, three hours, tomorrow morning and next Monday on an ordinary afternoon", () => {
    // Wednesday, Nov 4 2026, 2:15:30 PM
    const now = local(2026, 11, 4, 14, 15, 30);
    const presets = chatSnoozePresets(now, "en-US");
    expect(presets.map((p) => p.label)).toEqual([
      "In 1 hour",
      "In 3 hours",
      "Tomorrow, 9:00 AM",
      "Next week, Mon 9:00 AM",
    ]);
    // A menu with a time column shows each name beside when it brings the chat back.
    expect(presets.map((p) => [p.name, p.when])).toEqual([
      ["In 1 hour", "3:16 PM"],
      ["In 3 hours", "5:16 PM"],
      ["Tomorrow", "9:00 AM"],
      ["Next week", "Mon 9:00 AM"],
    ]);
    const times = presetTimes(now);
    // Relative presets land on a whole minute, never earlier than asked.
    expect(times["in-1-hour"]).toEqual(local(2026, 11, 4, 15, 16));
    expect(times["in-3-hours"]).toEqual(local(2026, 11, 4, 17, 16));
    expect(times["next-morning"]).toEqual(local(2026, 11, 5, 9));
    expect(times["next-week"]).toEqual(local(2026, 11, 9, 9));
  });

  it("keeps an exact whole minute instead of rounding it up", () => {
    expect(presetTimes(local(2026, 11, 4, 14, 15))["in-1-hour"]).toEqual(
      local(2026, 11, 4, 15, 15),
    );
  });

  it("means this morning in the small hours, but tomorrow once 9 AM is under three hours away", () => {
    const smallHours = chatSnoozePresets(local(2026, 11, 4, 1, 30), "en-US");
    expect(smallHours.find((p) => p.id === "next-morning")?.label).toBe("This morning, 9:00 AM");
    expect(new Date(smallHours.find((p) => p.id === "next-morning")!.snoozedUntil)).toEqual(
      local(2026, 11, 4, 9),
    );

    const early = presetTimes(local(2026, 11, 4, 6, 30));
    expect(early["next-morning"]).toEqual(local(2026, 11, 5, 9));
  });

  it("moves a Monday's next week a full week ahead", () => {
    expect(presetTimes(local(2026, 11, 9, 10))["next-week"]).toEqual(local(2026, 11, 16, 9));
  });

  it("drops next week from the menu when it lands on the same time as tomorrow morning", () => {
    // Sunday evening: tomorrow 9 AM is next week's Monday 9 AM.
    const sunday = local(2026, 11, 8, 20);
    const presets = chatSnoozePresets(sunday, "en-US");
    expect(presets.map((p) => p.id)).toEqual(["in-1-hour", "in-3-hours", "next-morning"]);
    // A surface that names next week by itself still gets that Monday.
    expect(new Date(chatSnoozePresetTime("next-week", sunday))).toEqual(local(2026, 11, 9, 9));
  });
});

describe("describeChatSnooze", () => {
  const now = local(2026, 11, 4, 14, 0);

  it("names the day relative to now", () => {
    expect(describeChatSnooze(local(2026, 11, 4, 17, 30).toISOString(), now, "en-US")).toBe(
      "Snoozed until today at 5:30 PM",
    );
    expect(describeChatSnooze(local(2026, 11, 5, 9).toISOString(), now, "en-US")).toBe(
      "Snoozed until tomorrow at 9:00 AM",
    );
    expect(describeChatSnooze(local(2026, 11, 9, 9).toISOString(), now, "en-US")).toBe(
      "Snoozed until Mon, Nov 9 at 9:00 AM",
    );
    expect(formatChatSnoozeTime(local(2027, 1, 4, 9).toISOString(), now, "en-US")).toBe(
      "Mon, Jan 4, 2027 at 9:00 AM",
    );
  });

  it("confirms and describes a snooze without depending on when it is read", () => {
    expect(formatChatSnoozeConfirmation(local(2026, 11, 5, 9).toISOString(), now, "en-US")).toBe(
      "Snoozed until tomorrow at 9:00 AM",
    );
    expect(describeChatSnoozeAbsolute(local(2026, 11, 5, 9).toISOString(), "en-US")).toBe(
      "Snoozed until Thu, Nov 5, 9:00 AM",
    );
  });

  it("calls a snooze at or past now due", () => {
    expect(describeChatSnooze(now.toISOString(), now, "en-US")).toBe("Snooze ended");
    expect(describeChatSnooze("not a time", now, "en-US")).toBe("Snooze ended");
  });
});

describe("custom snooze time", () => {
  // Wednesday, Nov 4 2026, 2:15:30 PM
  const now = local(2026, 11, 4, 14, 15, 30);

  it("starts the picker at the next morning, and allows nothing before the next minute", () => {
    expect(defaultCustomSnoozeInput(now)).toBe("2026-11-05T09:00");
    expect(minimumCustomSnoozeInput(now)).toBe("2026-11-04T14:17");
  });

  it.each([
    ["a later local time", "2026-11-06T18:30", local(2026, 11, 6, 18, 30).toISOString()],
    ["a time already past", "2026-11-04T14:15", null],
    ["an empty field", "", null],
    ["a day the month lacks", "2026-02-30T09:00", null],
    ["something else", "tomorrow", null],
  ] as const)("reads %s", (_name, value, expected) => {
    expect(parseCustomSnoozeInput(value, now)).toBe(expected);
  });
});
