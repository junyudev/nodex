import { describe, expect, it } from "vitest";
import {
  anchorSidebarChat,
  holdSidebarLanes,
  normalizeSidebarAutoSettleDays,
  normalizeSidebarHiddenShelves,
  normalizeSidebarOrganize,
  partitionSidebarChats,
  resolveAutoSettleIdleBefore,
  resolveChatAfterLeaving,
  resolveNextChatNeedingReader,
  resolveSettleableReadChats,
  resolveSidebarChatLane,
  resolveSidebarChatPreview,
  sidebarLaneOrder,
  stepSidebarChat,
  type SidebarLifecycleChat,
} from "./sidebar-chat-lifecycle";

function chat(id: string, overrides: Partial<SidebarLifecycleChat> = {}): SidebarLifecycleChat {
  return {
    id,
    pinned: false,
    snoozedUntil: null,
    snoozedAt: null,
    attentionAt: 0,
    status: null,
    ...overrides,
  };
}

const SOON = "2026-01-02T00:00:00.000Z";

describe("resolveSidebarChatLane", () => {
  it.each([
    ["an idle chat waits on its person", chat("a"), "active"],
    ["an unread chat stays where a read one sits", chat("a", { status: "unread" }), "active"],
    ["a running chat is its Agent's move", chat("a", { status: "running" }), "working"],
    ["background work is still its Agent's move", chat("a", { status: "background" }), "working"],
    [
      "a snooze sets a chat aside",
      chat("a", { snoozedUntil: "2026-01-02T00:00:00.000Z" }),
      "snoozed",
    ],
    [
      "a snooze sets a running chat aside too",
      chat("a", { snoozedUntil: "2026-01-02T00:00:00.000Z", status: "running" }),
      "snoozed",
    ],
    [
      "a snooze defers the request it was set on",
      chat("a", { snoozedUntil: SOON, snoozedAt: 20, attentionAt: 10, status: "attention" }),
      "snoozed",
    ],
    [
      "a request that comes after the snooze brings the chat back",
      chat("a", { snoozedUntil: SOON, snoozedAt: 20, attentionAt: 30, status: "attention" }),
      "active",
    ],
    [
      "a pinned chat keeps its place whatever it is doing",
      chat("a", { pinned: true, status: "attention", snoozedUntil: "2026-01-02T00:00:00.000Z" }),
      "pinned",
    ],
  ] as const)("%s", (_name, input, lane) => {
    expect(resolveSidebarChatLane(input)).toBe(lane);
  });
});

describe("partitionSidebarChats", () => {
  it("leads open chats with the ones an Agent is stopped on, then the most recent return", () => {
    const lanes = partitionSidebarChats([
      chat("old", { attentionAt: 10 }),
      chat("unread-new", { attentionAt: 40, status: "unread" }),
      chat("blocked-old", { attentionAt: 5, status: "attention" }),
      chat("blocked-new", { attentionAt: 30, status: "attention" }),
      chat("read-newer", { attentionAt: 50 }),
    ]);
    expect(lanes.active.map((entry) => entry.id)).toEqual([
      "blocked-new",
      "blocked-old",
      "read-newer",
      "unread-new",
      "old",
    ]);
  });

  it("keeps a chat in place when it is read", () => {
    const before = partitionSidebarChats([
      chat("a", { attentionAt: 30, status: "unread" }),
      chat("b", { attentionAt: 20 }),
    ]);
    const after = partitionSidebarChats([
      chat("a", { attentionAt: 30 }),
      chat("b", { attentionAt: 20 }),
    ]);
    expect(after.active.map((entry) => entry.id)).toEqual(before.active.map((entry) => entry.id));
  });

  it("keeps the person's own pin order and wakes the chat due soonest first", () => {
    const lanes = partitionSidebarChats([
      chat("pin-2", { pinned: true, attentionAt: 1 }),
      chat("pin-1", { pinned: true, attentionAt: 99 }),
      chat("next-week", { snoozedUntil: "2026-01-09T00:00:00.000Z" }),
      chat("tomorrow", { snoozedUntil: "2026-01-02T00:00:00.000Z" }),
      chat("working-old", { attentionAt: 1, status: "running" }),
      chat("working-new", { attentionAt: 2, status: "background" }),
    ]);
    expect(lanes.pinned.map((entry) => entry.id)).toEqual(["pin-2", "pin-1"]);
    expect(lanes.snoozed.map((entry) => entry.id)).toEqual(["tomorrow", "next-week"]);
    expect(lanes.working.map((entry) => entry.id)).toEqual(["working-new", "working-old"]);
  });

  it("orders chats that came back at the same instant the same way every time", () => {
    const first = partitionSidebarChats([
      chat("b", { attentionAt: 5 }),
      chat("a", { attentionAt: 5 }),
    ]);
    const second = partitionSidebarChats([
      chat("a", { attentionAt: 5 }),
      chat("b", { attentionAt: 5 }),
    ]);
    expect(first.active.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(second.active.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("the chat on screen keeps its place", () => {
  const before = [
    chat("top", { attentionAt: 30 }),
    chat("open", { attentionAt: 20, status: "attention" }),
    chat("below", { attentionAt: 10 }),
  ];

  it("stays where it was while its Agent works on the reader's answer", () => {
    const anchor = anchorSidebarChat(before[1]!);
    // The reader answered: the chat came back to them later and its Agent started working.
    const after = [before[0]!, chat("open", { attentionAt: 40, status: "running" }), before[2]!];
    const lanes = partitionSidebarChats(after, anchor);
    expect(lanes.active.map((entry) => entry.id)).toEqual(["open", "top", "below"]);
    expect(lanes.working).toEqual([]);
    // Without the anchor it would have left for Working.
    expect(partitionSidebarChats(after).working.map((entry) => entry.id)).toEqual(["open"]);
  });

  it("moves at once when the reader sets it aside", () => {
    const anchor = anchorSidebarChat(before[1]!);
    const lanes = partitionSidebarChats(
      [before[0]!, chat("open", { snoozedUntil: SOON, snoozedAt: 50, attentionAt: 20 })],
      anchor,
    );
    expect(lanes.snoozed.map((entry) => entry.id)).toEqual(["open"]);
  });
});

describe("holdSidebarLanes", () => {
  const ids = (lanes: ReturnType<typeof holdSidebarLanes<{ id: string }>>) =>
    sidebarLaneOrder(lanes);
  const lanes = (
    order: Partial<Record<"pinned" | "active" | "working" | "snoozed", string[]>>,
  ) => ({
    pinned: (order.pinned ?? []).map((id) => ({ id })),
    active: (order.active ?? []).map((id) => ({ id })),
    working: (order.working ?? []).map((id) => ({ id })),
    snoozed: (order.snoozed ?? []).map((id) => ({ id })),
  });
  const held = sidebarLaneOrder(lanes({ active: ["a", "b", "c"], working: ["w"] }));

  it("keeps every row the reader saw in its lane and place", () => {
    const fresh = lanes({ active: ["c", "a"], working: ["b", "w"] });
    expect(ids(holdSidebarLanes(fresh, held, new Set()))).toEqual(
      sidebarLaneOrder(lanes({ active: ["a", "b", "c"], working: ["w"] })),
    );
  });

  it("holds back a chat that came back above the rows they saw", () => {
    const fresh = lanes({ active: ["new", "a", "b", "c"], working: ["w"] });
    expect(ids(holdSidebarLanes(fresh, held, new Set())).active).toEqual(["a", "b", "c"]);
  });

  it("shows a page of older chats they asked for below the rows they saw", () => {
    const fresh = lanes({ active: ["a", "b", "c", "older"], working: ["w"] });
    expect(ids(holdSidebarLanes(fresh, held, new Set())).active).toEqual(["a", "b", "c", "older"]);
  });

  it("lets a chat they acted on move, and drops one that left the list", () => {
    const fresh = lanes({ pinned: ["b"], active: ["a"], working: ["w"] });
    expect(ids(holdSidebarLanes(fresh, held, new Set(["b"])))).toEqual(
      sidebarLaneOrder(lanes({ pinned: ["b"], active: ["a"], working: ["w"] })),
    );
  });

  it("shows the fresh lanes once the reader leaves", () => {
    const fresh = lanes({ active: ["new", "a"] });
    expect(holdSidebarLanes(fresh, null, new Set())).toBe(fresh);
  });
});

describe("resolveSettleableReadChats", () => {
  it("settles read chats that ask nothing, in lane order", () => {
    const active = [
      chat("asks", { status: "attention" }),
      chat("read"),
      chat("unread", { status: "unread" }),
      chat("draft"),
      chat("in-review"),
      chat("working", { status: "running" }),
      chat("read-too"),
    ];
    // A draft has no conversation, and a chat whose Page waits for review still asks.
    const quiet = (id: string) => id !== "draft" && id !== "in-review";
    expect(resolveSettleableReadChats(active, quiet)).toEqual(["read", "read-too"]);
  });
});

describe("resolveChatAfterLeaving", () => {
  it.each([
    ["the row below takes its place", ["a", "b", "c"], "b", "c"],
    ["the last row hands over to the one above", ["a", "b", "c"], "c", "b"],
    ["the only row leaves nothing", ["a"], "a", null],
    ["an unlisted chat changes nothing", ["a", "b"], "z", null],
  ] as const)("%s", (_name, ids, leaving, expected) => {
    expect(resolveChatAfterLeaving(ids, leaving)).toBe(expected);
  });
});

describe("stepSidebarChat", () => {
  it.each([
    ["next moves down", ["a", "b", "c"], "a", "next", "b"],
    ["next wraps to the top", ["a", "b", "c"], "c", "next", "a"],
    ["previous wraps to the bottom", ["a", "b", "c"], "a", "previous", "c"],
    ["with no chat open, next starts at the top", ["a", "b"], null, "next", "a"],
    ["with an unlisted chat open, previous starts at the bottom", ["a", "b"], "z", "previous", "b"],
    ["the only chat has no neighbour", ["a"], "a", "next", null],
    ["an empty list has nowhere to go", [], null, "next", null],
  ] as const)("%s", (_name, ids, current, direction, expected) => {
    expect(stepSidebarChat(ids, current, direction)).toBe(expected);
  });
});

describe("resolveNextChatNeedingReader", () => {
  const chats = [
    { id: "a", needsReader: true },
    { id: "b", needsReader: false },
    { id: "c", needsReader: true },
  ];

  it.each([
    ["starts below the current chat", "a", "c"],
    ["wraps past the end", "c", "a"],
    ["starts at the top with no chat open", null, "a"],
    ["starts at the top when the open chat is not listed", "z", "a"],
  ] as const)("%s", (_name, current, expected) => {
    expect(resolveNextChatNeedingReader(chats, current)).toBe(expected);
  });

  it("finds nothing when only the current chat asks for its reader", () => {
    expect(resolveNextChatNeedingReader([{ id: "a", needsReader: true }], "a")).toBeNull();
    expect(resolveNextChatNeedingReader([{ id: "a", needsReader: false }], null)).toBeNull();
  });
});

describe("sidebar lifecycle preferences", () => {
  it("defaults to arranging by attention and settling idle chats after a week", () => {
    expect(normalizeSidebarOrganize(undefined)).toBe("attention");
    expect(normalizeSidebarOrganize("project")).toBe("project");
    expect(normalizeSidebarAutoSettleDays(undefined)).toBe(7);
    expect(normalizeSidebarAutoSettleDays(3)).toBe(3);
    expect(normalizeSidebarAutoSettleDays(0)).toBe(7);
    expect(normalizeSidebarAutoSettleDays(1.5)).toBe(7);
  });

  it("keeps the person's choice never to settle idle chats", () => {
    expect(normalizeSidebarAutoSettleDays(null)).toBeNull();
  });

  it("hides only lists that can be hidden, once each, in the order they show", () => {
    expect(normalizeSidebarHiddenShelves(undefined)).toEqual([]);
    // Active is what the arrangement is for, so it never hides.
    expect(normalizeSidebarHiddenShelves(["settled", "active", "working", "settled", 3])).toEqual([
      "working",
      "settled",
    ]);
  });

  it("counts idle time in whole days", () => {
    const now = Date.UTC(2026, 0, 8);
    expect(resolveAutoSettleIdleBefore(now, 7)).toBe(Date.UTC(2026, 0, 1));
  });
});

describe("resolveSidebarChatPreview", () => {
  const idle = {
    turn: null,
    needsApproval: false,
    approvalPrompt: null,
    readback: null,
    reply: "Shipped it.",
  };
  const text = (value: string | null) => (value === null ? null : { lead: null, text: value });

  it.each([
    ["a quiet chat shows its latest reply", idle, text("Shipped it.")],
    [
      "a working chat says what its Agent set out to do",
      { ...idle, readback: "I'll **profile** the sidebar first." },
      text("I'll profile the sidebar first."),
    ],
    [
      "a chat waiting on an approval shows what it asks",
      {
        ...idle,
        needsApproval: true,
        approvalPrompt: "Run `pnpm install`?",
        readback: "Setting up",
      },
      text("Run pnpm install?"),
    ],
    [
      "an approval with nothing to show falls back to the Run's statement",
      { ...idle, needsApproval: true, readback: "Setting up" },
      text("Setting up"),
    ],
    ["a chat that has said nothing yet shows nothing", { ...idle, reply: null }, null],
    [
      "a chat whose Page waits on the reader leads with the Page's words",
      { ...idle, turn: "Ready for your review" },
      { lead: "Ready for your review", text: "Shipped it." },
    ],
    [
      "the Page's words stand alone when the chat has said nothing",
      { ...idle, turn: "Needs your answer", reply: null },
      { lead: "Needs your answer", text: null },
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(resolveSidebarChatPreview(input)).toEqual(expected);
  });
});
