import { describe, expect, test } from "vite-plus/test";
import type { InboxItem } from "../../../shared/inbox";
import {
  describeBackFromLater,
  describeLaterConfirmation,
  describeLaterOutcome,
  formatLaterClock,
  laterSections,
} from "./inbox-later";

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
// Wednesday, Nov 4 2026, 2:15 PM
const now = local(2026, 11, 4, 14, 15);
const at = (date: Date) => date.toISOString();
const setAside = (pageId: string, remindAt: Date): InboxItem =>
  ({
    pageId,
    later: {
      setAt: at(local(2026, 11, 3, 10)),
      until: at(remindAt),
    },
  }) as InboxItem;

describe("Later wording", () => {
  test("names when a message comes back", () => {
    expect(describeLaterOutcome(at(local(2026, 11, 5, 9)), now, "en-US")).toBe(
      "Later · tomorrow at 9:00 AM",
    );
    expect(describeLaterOutcome(at(local(2026, 11, 4, 17, 16)), now, "en-US")).toBe(
      "Later · today at 5:16 PM",
    );
  });

  test("confirms one message or several", () => {
    expect(describeLaterConfirmation(at(local(2026, 11, 5, 9)), 1, now, "en-US")).toBe(
      "Set aside until tomorrow at 9:00 AM",
    );
    expect(describeLaterConfirmation(at(local(2026, 11, 5, 9)), 3, now, "en-US")).toBe(
      "Set 3 messages aside until tomorrow at 9:00 AM",
    );
  });

  test("a returned message says when it was set aside; one still waiting says nothing", () => {
    const record = { setAt: at(local(2026, 11, 3, 10)), until: at(now) };
    expect(
      describeBackFromLater({ ...record, until: at(local(2026, 11, 5)) }, now, "en-US"),
    ).toBeNull();
    expect(describeBackFromLater(null, now, "en-US")).toBeNull();
    expect(describeBackFromLater(record, now, "en-US")).toBe(
      "Back from Later · set aside yesterday",
    );
    expect(
      describeBackFromLater({ setAt: at(local(2026, 10, 20, 10)), until: at(now) }, now, "en-US"),
    ).toBe("Back from Later · set aside on Oct 20");
    expect(
      describeBackFromLater({ setAt: at(local(2026, 11, 4, 9)), until: at(now) }, now, "en-US"),
    ).toBe("Back from Later · set aside earlier today");
  });
});

describe("laterSections", () => {
  test("groups by the day each message returns", () => {
    const sections = laterSections(
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
    expect(laterSections([setAside("a", local(2026, 11, 3, 9))], now, "en-US")[0]?.label).toBe(
      "Today",
    );
  });

  test("a row adds only the time of day", () => {
    expect(formatLaterClock(at(local(2026, 11, 5, 9)), "en-US")).toBe("9:00 AM");
  });
});
