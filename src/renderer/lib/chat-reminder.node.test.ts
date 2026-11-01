import { describe, expect, it } from "vitest";
import {
  chatReminderPresetTime,
  chatReminderPresets,
  describeChatReminder,
  describeChatReminderAbsolute,
  formatChatReminderConfirmation,
  formatChatReminderTime,
} from "./chat-reminder";

const local = (y: number, m: number, d: number, h: number, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s);
const presetTimes = (now: Date) =>
  Object.fromEntries(chatReminderPresets(now, "en-US").map((p) => [p.id, new Date(p.remindAt)]));

describe("chatReminderPresets", () => {
  it("offers an hour, three hours, tomorrow morning and next Monday on an ordinary afternoon", () => {
    // Wednesday, Nov 4 2026, 2:15:30 PM
    const now = local(2026, 11, 4, 14, 15, 30);
    const presets = chatReminderPresets(now, "en-US");
    expect(presets.map((p) => p.label)).toEqual([
      "In 1 hour",
      "In 3 hours",
      "Tomorrow, 9:00 AM",
      "Next week, Mon 9:00 AM",
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
    const smallHours = chatReminderPresets(local(2026, 11, 4, 1, 30), "en-US");
    expect(smallHours.find((p) => p.id === "next-morning")?.label).toBe("This morning, 9:00 AM");
    expect(new Date(smallHours.find((p) => p.id === "next-morning")!.remindAt)).toEqual(
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
    const presets = chatReminderPresets(sunday, "en-US");
    expect(presets.map((p) => p.id)).toEqual(["in-1-hour", "in-3-hours", "next-morning"]);
    // A surface that names next week by itself still gets that Monday.
    expect(new Date(chatReminderPresetTime("next-week", sunday))).toEqual(local(2026, 11, 9, 9));
  });
});

describe("describeChatReminder", () => {
  const now = local(2026, 11, 4, 14, 0);

  it("names the day relative to now", () => {
    expect(describeChatReminder(local(2026, 11, 4, 17, 30).toISOString(), now, "en-US")).toBe(
      "Reminds you today at 5:30 PM",
    );
    expect(describeChatReminder(local(2026, 11, 5, 9).toISOString(), now, "en-US")).toBe(
      "Reminds you tomorrow at 9:00 AM",
    );
    expect(describeChatReminder(local(2026, 11, 9, 9).toISOString(), now, "en-US")).toBe(
      "Reminds you Mon, Nov 9 at 9:00 AM",
    );
    expect(formatChatReminderTime(local(2027, 1, 4, 9).toISOString(), now, "en-US")).toBe(
      "Mon, Jan 4, 2027 at 9:00 AM",
    );
  });

  it("confirms and describes a reminder without depending on when it is read", () => {
    expect(formatChatReminderConfirmation(local(2026, 11, 5, 9).toISOString(), now, "en-US")).toBe(
      "Reminder set for tomorrow at 9:00 AM",
    );
    expect(describeChatReminderAbsolute(local(2026, 11, 5, 9).toISOString(), "en-US")).toBe(
      "Reminder for Thu, Nov 5, 9:00 AM",
    );
  });

  it("calls a reminder at or past now due", () => {
    expect(describeChatReminder(now.toISOString(), now, "en-US")).toBe("Reminder due");
    expect(describeChatReminder("not a time", now, "en-US")).toBe("Reminder due");
  });
});
