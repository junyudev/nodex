import { describe, expect, test } from "vite-plus/test";
import type { InboxItem } from "../../../shared/inbox";
import {
  describeBackFromSnooze,
  describeInboxSnoozeConfirmation,
  describeInboxSnoozedOutcome,
  formatSnoozeClock,
  snoozedSections,
} from "./inbox-snooze";

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
// Wednesday, Nov 4 2026, 2:15 PM
const now = local(2026, 11, 4, 14, 15);
const at = (date: Date) => date.toISOString();
const setAside = (pageId: string, snoozedUntil: Date): InboxItem =>
  ({
    pageId,
    snooze: {
      setAt: at(local(2026, 11, 3, 10)),
      until: at(snoozedUntil),
    },
  }) as InboxItem;

describe("Snooze wording", () => {
  test("names when a message comes back", () => {
    expect(describeInboxSnoozedOutcome(at(local(2026, 11, 5, 9)), now, "en-US")).toBe(
      "Snoozed · tomorrow at 9:00 AM",
    );
    expect(describeInboxSnoozedOutcome(at(local(2026, 11, 4, 17, 16)), now, "en-US")).toBe(
      "Snoozed · today at 5:16 PM",
    );
  });

  test("confirms one message or several", () => {
    expect(describeInboxSnoozeConfirmation(at(local(2026, 11, 5, 9)), 1, now, "en-US")).toBe(
      "Snoozed until tomorrow at 9:00 AM",
    );
    expect(describeInboxSnoozeConfirmation(at(local(2026, 11, 5, 9)), 3, now, "en-US")).toBe(
      "Snoozed 3 messages until tomorrow at 9:00 AM",
    );
  });

  test("a returned message says when it was set aside; one still waiting says nothing", () => {
    const record = { setAt: at(local(2026, 11, 3, 10)), until: at(now) };
    expect(
      describeBackFromSnooze({ ...record, until: at(local(2026, 11, 5)) }, now, "en-US"),
    ).toBeNull();
    expect(describeBackFromSnooze(null, now, "en-US")).toBeNull();
    expect(describeBackFromSnooze(record, now, "en-US")).toBe("Back from snooze · set yesterday");
    expect(
      describeBackFromSnooze({ setAt: at(local(2026, 10, 20, 10)), until: at(now) }, now, "en-US"),
    ).toBe("Back from snooze · set on Oct 20");
    expect(
      describeBackFromSnooze({ setAt: at(local(2026, 11, 4, 9)), until: at(now) }, now, "en-US"),
    ).toBe("Back from snooze · set earlier today");
  });
});

describe("snoozedSections", () => {
  test("groups by the day each message returns", () => {
    const sections = snoozedSections(
      [
        setAside("a", local(2026, 11, 4, 17)),
        setAside("b", local(2026, 11, 5, 9)),
        setAside("c", local(2026, 11, 5, 15)),
        setAside("d", local(2026, 11, 9, 9)),
        setAside("e", local(2026, 12, 1, 9)),
      ],
      now,
      "en-US",
    );
    expect(sections.map((section) => [section.label, section.items.map((i) => i.pageId)])).toEqual([
      ["Today", ["a"]],
      ["Tomorrow", ["b", "c"]],
      ["Monday", ["d"]],
      ["Dec 1", ["e"]],
    ]);
  });

  test("a time already reached still reads as today until Core returns it", () => {
    expect(snoozedSections([setAside("a", local(2026, 11, 3, 9))], now, "en-US")[0]?.label).toBe(
      "Today",
    );
  });

  test("a row adds only the time of day", () => {
    expect(formatSnoozeClock(at(local(2026, 11, 5, 9)), "en-US")).toBe("9:00 AM");
  });
});
