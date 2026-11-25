import { describe, expect, it } from "vitest";

import { groupBySettledDay, settledDayBucket } from "./settled-chats-model";
import { buildSettledChatsPath, parseSettledChatsPath } from "./settled-chats-routes";

const at = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour).getTime();

describe("settledDayBucket", () => {
  const now = at(2026, 11, 25, 9);

  it("names the reader's calendar days, not 24-hour spans", () => {
    expect(settledDayBucket(at(2026, 11, 25, 0), now)).toEqual({ kind: "today" });
    expect(settledDayBucket(at(2026, 11, 24, 23), now)).toEqual({ kind: "yesterday" });
    expect(settledDayBucket(at(2026, 11, 19), now)).toEqual({ kind: "previous-7-days" });
    expect(settledDayBucket(at(2026, 11, 18), now)).toEqual({ kind: "previous-30-days" });
    expect(settledDayBucket(at(2026, 10, 27), now)).toEqual({ kind: "previous-30-days" });
    expect(settledDayBucket(at(2026, 10, 26), now)).toEqual({
      kind: "month",
      year: 2026,
      month: 9,
    });
  });

  it("keeps a time slightly ahead of the clock in today", () => {
    expect(settledDayBucket(now + 60_000, now)).toEqual({ kind: "today" });
  });
});

describe("groupBySettledDay", () => {
  const now = at(2026, 11, 25, 9);

  it("runs consecutive chats of one bucket together, newest first", () => {
    const chats = [
      { id: "a", settledAt: at(2026, 11, 25, 8) },
      { id: "b", settledAt: at(2026, 11, 25, 1) },
      { id: "c", settledAt: at(2026, 11, 24) },
      { id: "d", settledAt: at(2026, 9, 3) },
      { id: "e", settledAt: at(2025, 9, 3) },
    ];
    const groups = groupBySettledDay(chats, (chat) => chat.settledAt, now);
    expect(groups.map((group) => [group.key, group.items.map((chat) => chat.id)])).toEqual([
      ["today", ["a", "b"]],
      ["yesterday", ["c"]],
      ["month:2026-8", ["d"]],
      ["month:2025-8", ["e"]],
    ]);
  });

  it("keeps a chat without a settlement time in the run before it", () => {
    const chats = [
      { id: "a", settledAt: at(2026, 11, 24) },
      { id: "b", settledAt: null },
      { id: "c", settledAt: at(2026, 11, 2) },
    ];
    const groups = groupBySettledDay(chats, (chat) => chat.settledAt, now);
    expect(groups.map((group) => group.items.map((chat) => chat.id))).toEqual([["a", "b"], ["c"]]);
  });
});

describe("settled chats path", () => {
  it("round-trips a Project filter and reads the bare page as every Project", () => {
    expect(parseSettledChatsPath(buildSettledChatsPath("p 1&x"))).toEqual({ projectId: "p 1&x" });
    expect(parseSettledChatsPath(buildSettledChatsPath(null))).toEqual({ projectId: null });
    expect(parseSettledChatsPath("/settled?project=")).toEqual({ projectId: null });
  });
});
