import { describe, expect, it, test } from "vite-plus/test";
import {
  anchorSidebarChat,
  countChatsAskingReader,
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
import {
  listExpandedVisibleProjectGroupIds,
  listReopenableVisibleProjectGroupIds,
  resolveSidebarProjectGroupCollapseAction,
} from "./sidebar-project-group-collapse-action";
import type { SessionSidebarPlacement, SidebarSectionItem } from "../../shared/sidebar-sections";
import type { SessionLiveIndicator } from "./session-execution";
import {
  buildSidebarRuntimeGroupActivities,
  mergeRuntimeProjectActivity,
} from "./sidebar-runtime-group-activity";
import type { ProjectSessionSummary, CodexSidebarThreadItem } from "../../shared/types";
import { sidebarSectionChatIds } from "./sidebar-section-navigation";
import {
  makeDefaultSidebarCollapsibleSectionsState,
  normalizeSidebarCollapsibleSectionsState,
  normalizeSidebarListExtraPages,
  withSidebarListExtraPages,
} from "./sidebar-section-prefs";
import { resolveSidebarSessionPlacement } from "./sidebar-session-placement";
import {
  nativeThreadWaitsOnPerson,
  resolveSidebarGroupStatus,
  resolveSidebarRowRestingStatus,
  resolveSidebarRowStatus,
} from "./sidebar-status";
import { projectSidebarThreadRowLiveView } from "./sidebar-thread-row-live-view";

describe("sidebar chat lifecycle", () => {
  function chat(id: string, overrides: Partial<SidebarLifecycleChat> = {}): SidebarLifecycleChat {
    return {
      id,
      pinned: false,
      pinnedOrder: null,
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
      expect(ids(holdSidebarLanes(fresh, held, new Set())).active).toEqual([
        "a",
        "b",
        "c",
        "older",
      ]);
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
      [
        "with an unlisted chat open, previous starts at the bottom",
        ["a", "b"],
        "z",
        "previous",
        "b",
      ],
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

  it("counts the chats asking for their reader, leaving snoozed ones until a new request", () => {
    expect(
      countChatsAskingReader([
        chat("waiting", { status: "attention" }),
        chat("news", { status: "unread" }),
        chat("pinned news", { pinned: true, status: "unread" }),
        chat("working", { status: "running" }),
        chat("read", { status: null }),
        chat("deferred", {
          snoozedUntil: SOON,
          snoozedAt: 20,
          attentionAt: 10,
          status: "attention",
        }),
        chat("asked again", {
          snoozedUntil: SOON,
          snoozedAt: 20,
          attentionAt: 30,
          status: "attention",
        }),
      ]),
    ).toBe(4);
  });

  describe("sidebar lifecycle preferences", () => {
    it("defaults to the Project tree and settling idle chats after a week", () => {
      expect(normalizeSidebarOrganize(undefined)).toBe("project");
      expect(normalizeSidebarOrganize("attention")).toBe("attention");
      expect(normalizeSidebarOrganize("unknown")).toBe("project");
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
      expect(normalizeSidebarHiddenShelves(["settled", "active", "working", "settled", 3])).toEqual(
        ["working", "settled"],
      );
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
});

describe("sidebar project group collapse action", () => {
  test("shows Collapse all only when more than one visible group is expanded", () => {
    const visibleGroupIds = ["alpha", "beta", "gamma"];

    expect(
      resolveSidebarProjectGroupCollapseAction({
        visibleGroupIds,
        expandedGroupIds: new Set(["alpha", "beta"]),
        previouslyExpandedGroupIds: [],
      }),
    ).toBe("collapse-all");

    expect(
      resolveSidebarProjectGroupCollapseAction({
        visibleGroupIds,
        expandedGroupIds: new Set(["alpha"]),
        previouslyExpandedGroupIds: [],
      }),
    ).toBe(null);
  });

  test("shows Reopen previous after all visible groups from the previous collapse are closed", () => {
    expect(
      resolveSidebarProjectGroupCollapseAction({
        visibleGroupIds: ["alpha", "beta"],
        expandedGroupIds: new Set(),
        previouslyExpandedGroupIds: ["alpha", "beta"],
      }),
    ).toBe("reopen-previous");

    expect(
      resolveSidebarProjectGroupCollapseAction({
        visibleGroupIds: ["alpha", "beta"],
        expandedGroupIds: new Set(["alpha"]),
        previouslyExpandedGroupIds: ["alpha", "beta"],
      }),
    ).toBe(null);
  });

  test("filters action inputs to visible project groups", () => {
    expect(
      JSON.stringify(
        listExpandedVisibleProjectGroupIds(["alpha", "beta"], new Set(["alpha", "hidden"])),
      ),
    ).toBe(JSON.stringify(["alpha"]));

    expect(
      JSON.stringify(listReopenableVisibleProjectGroupIds(["alpha", "beta"], ["hidden", "beta"])),
    ).toBe(JSON.stringify(["beta"]));
  });
});

describe("sidebar runtime group activity", () => {
  const placement = (
    sessionId: string,
    unread = false,
    projectId: string | null = "project",
    sectionId: string | null = "section",
  ): SessionSidebarPlacement => ({ sessionId, unread, projectId, sectionId, snoozedUntil: null });

  const core = {
    projectId: "project",
    taskCount: 5,
    waitingCount: 1,
    unreadCount: 2,
    activeCount: 0,
  };

  describe("sidebar Runtime group activity", () => {
    it("joins live Sessions to both groups without requiring loaded rows", () => {
      const activities = new Map<string, { status: SessionLiveIndicator }>([
        ["waiting-unread", { status: "waiting" }],
        ["running", { status: "running" }],
        ["background-unread", { status: "background" }],
        ["archived-or-missing", { status: "waiting" }],
      ]);
      const groups = buildSidebarRuntimeGroupActivities(
        [
          placement("waiting-unread", true),
          placement("running"),
          placement("background-unread", true),
          placement("idle"),
          placement("running"),
        ],
        activities,
      );
      const runtime = {
        waitingCount: 1,
        runningCount: 2,
        unreadWaitingCount: 1,
        unreadRunningCount: 1,
      };
      expect([...groups.projects]).toEqual([["project", runtime]]);
      expect([...groups.sections]).toEqual([["section", runtime]]);
      expect(mergeRuntimeProjectActivity(core, groups.projects.get("project"))).toEqual({
        ...core,
        waitingCount: 2,
        unreadCount: 1,
        activeCount: 1,
      });
      expect(core.unreadCount).toBe(2);
    });

    it.each([
      ["waiting", false, 1, 2, 0],
      ["waiting", true, 1, 1, 0],
      ["running", false, 0, 2, 1],
      ["running", true, 0, 2, 0],
      ["background", false, 0, 2, 1],
      ["background", true, 0, 2, 0],
    ] as const)(
      "keeps %s and unread=%s in exclusive Project buckets",
      (status, unread, waiting, unreadCount, active) => {
        const groups = buildSidebarRuntimeGroupActivities(
          [placement("session", unread)],
          new Map([["session", { status }]]),
        );
        expect(mergeRuntimeProjectActivity(core, groups.projects.get("project"))).toEqual({
          ...core,
          waitingCount: core.waitingCount + waiting,
          unreadCount,
          activeCount: active,
        });
      },
    );

    it("keeps Project and effective Section membership independent, including projectless Sessions", () => {
      const groups = buildSidebarRuntimeGroupActivities(
        [
          placement("override", false, "project", "override"),
          placement("projectless", true, null, "direct"),
          placement("unplaced", false, "other", null),
        ],
        new Map([
          ["override", { status: "waiting" }],
          ["projectless", { status: "background" }],
          ["unplaced", { status: "running" }],
        ]),
      );
      expect([...groups.projects.keys()]).toEqual(["project", "other"]);
      expect([...groups.sections.keys()]).toEqual(["override", "direct"]);
      expect(groups.sections.get("direct")).toEqual({
        waitingCount: 0,
        runningCount: 1,
        unreadWaitingCount: 0,
        unreadRunningCount: 1,
      });
    });

    it("removes settled activity and preserves unknown Core summaries", () => {
      const groups = buildSidebarRuntimeGroupActivities([placement("settled")], new Map());
      expect(groups.projects.size).toBe(0);
      expect(groups.sections.size).toBe(0);
      expect(mergeRuntimeProjectActivity(core, undefined)).toBe(core);
      const runtime = {
        waitingCount: 2,
        runningCount: 0,
        unreadWaitingCount: 2,
        unreadRunningCount: 0,
      };
      expect(mergeRuntimeProjectActivity(undefined, runtime)).toBeUndefined();
      expect(mergeRuntimeProjectActivity(null, runtime)).toBeNull();
      expect(mergeRuntimeProjectActivity({ ...core, unreadCount: 0 }, runtime)?.unreadCount).toBe(
        0,
      );
    });
  });
});

describe("sidebar section navigation", () => {
  function chat(
    id: string,
    projectId: string | null,
    settledAt: number | null = null,
  ): SidebarSectionItem {
    return {
      placementId: `placement:${id}`,
      rankKey: 0,
      revision: 1,
      kind: "session",
      session: { id, projectId, settledAt } as ProjectSessionSummary,
    };
  }

  function project(projectId: string): SidebarSectionItem {
    return {
      placementId: `placement:${projectId}`,
      rankKey: 0,
      revision: 1,
      kind: "project",
      project: {
        projectId,
        name: projectId,
        lifecycle: "active",
        appearance: {} as never,
        pinned: false,
      },
    };
  }

  describe("sidebarSectionChatIds", () => {
    const itemsBySectionId = new Map<string, readonly SidebarSectionItem[]>([
      ["release", [chat("rollback", "core"), chat("shipped", "nodex", 5), project("web")]],
      ["later", [chat("notes", null)]],
    ]);
    const base = {
      sectionIds: ["release", "later"],
      itemsBySectionId,
      collapsed: () => false,
      projectChatIds: (projectId: string) => (projectId === "web" ? ["web-a", "web-b"] : []),
    };

    it("walks each Section's open chats in order, with a placed Project's chats beneath it", () => {
      // A chat waiting on the reader inside a Section is reachable where it sits.
      expect(sidebarSectionChatIds(base)).toEqual(["rollback", "web-a", "web-b", "notes"]);
    });

    it("skips a folded Section", () => {
      expect(
        sidebarSectionChatIds({ ...base, collapsed: (sectionId) => sectionId === "later" }),
      ).toEqual(["rollback", "web-a", "web-b"]);
    });
  });
});

describe("sidebar-section-prefs", () => {
  test("normalizes built-in state and preserves bounded custom disclosure keys", () => {
    const defaults = makeDefaultSidebarCollapsibleSectionsState();
    const state = normalizeSidebarCollapsibleSectionsState({
      pinned: true,
      projects: "collapsed",
      chats: true,
      custom: true,
      "custom:section-alpha": true,
    });

    expect(defaults.pinned).toBe(false);
    expect(defaults.pages).toBe(false);
    expect(state.pinned).toBe(true);
    expect(state.projects).toBe(false);
    expect(state.chats).toBe(true);
    expect(state["custom:section-alpha"]).toBe(true);
    expect(state.custom).toBeUndefined();
  });

  test("migrates the retired Library collapse preference to Pages", () => {
    expect(normalizeSidebarCollapsibleSectionsState({ library: true }).pages).toBe(true);
  });

  test("keeps positive whole Show more depths for built-in, Project, and custom lists", () => {
    expect(
      normalizeSidebarListExtraPages({
        pages: 3,
        projects: 0,
        chats: -1,
        pinned: 2.5,
        "project:alpha": 2,
        "custom:section-alpha": 1,
        "project:": 4,
        library: 4,
      }),
    ).toEqual({ pages: 3, "project:alpha": 2, "custom:section-alpha": 1 });
    expect(normalizeSidebarListExtraPages({ pages: 1e9 }).pages).toBe(1000);
    expect(normalizeSidebarListExtraPages(["pages"])).toEqual({});
  });

  test("records a depth and forgets a list that returns to its first page", () => {
    const deeper = withSidebarListExtraPages({}, "project:alpha", 2);
    expect(deeper).toEqual({ "project:alpha": 2 });
    expect(withSidebarListExtraPages(deeper, "project:alpha", 2)).toBe(deeper);
    expect(withSidebarListExtraPages(deeper, "project:alpha", 0)).toEqual({});
  });

  test("remembers the most recently changed lists when Projects come and go", () => {
    let state = {};
    for (let index = 0; index < 205; index += 1) {
      state = withSidebarListExtraPages(state, `project:${index}`, 1);
    }
    state = withSidebarListExtraPages(state, "project:10", 2);
    const remembered = Object.keys(state);
    expect(remembered).toHaveLength(200);
    expect(remembered).not.toContain("project:4");
    expect(remembered[0]).toBe("project:5");
    expect(remembered.at(-1)).toBe("project:10");
    expect(Object.keys(normalizeSidebarListExtraPages(state))).toEqual(remembered);
  });
});

describe("sidebar session placement", () => {
  const sessionIdOf = (threadKey: string) =>
    threadKey.startsWith("pending:") ? null : `session-${threadKey}`;

  describe("resolveSidebarSessionPlacement", () => {
    it("anchors a moved chat before the chat now below it", () => {
      expect(
        resolveSidebarSessionPlacement({
          activeThreadKey: "c",
          nextVisibleThreadKeys: ["a", "c", "b"],
          getSessionId: sessionIdOf,
        }),
      ).toEqual({ sessionId: "session-c", placement: { kind: "before", sessionId: "session-b" } });
    });

    it("anchors a chat moved to the end after the chat above it", () => {
      expect(
        resolveSidebarSessionPlacement({
          activeThreadKey: "a",
          nextVisibleThreadKeys: ["b", "c", "a"],
          getSessionId: sessionIdOf,
        }),
      ).toEqual({ sessionId: "session-a", placement: { kind: "after", sessionId: "session-c" } });
    });

    it("falls back to the chat above when the row below has no Session yet", () => {
      expect(
        resolveSidebarSessionPlacement({
          activeThreadKey: "a",
          nextVisibleThreadKeys: ["b", "a", "pending:x"],
          getSessionId: sessionIdOf,
        }),
      ).toEqual({ sessionId: "session-a", placement: { kind: "after", sessionId: "session-b" } });
    });

    it("has no placement without a Session or a neighbor", () => {
      expect(
        resolveSidebarSessionPlacement({
          activeThreadKey: "pending:x",
          nextVisibleThreadKeys: ["a", "pending:x"],
          getSessionId: sessionIdOf,
        }),
      ).toBeNull();
      expect(
        resolveSidebarSessionPlacement({
          activeThreadKey: "a",
          nextVisibleThreadKeys: ["a"],
          getSessionId: sessionIdOf,
        }),
      ).toBeNull();
    });
  });
});

describe("resolveSidebarRowStatus", () => {
  const idle = { unread: false, running: false, background: false, needsAttention: false };

  test.each([
    [{ ...idle }, null],
    [{ ...idle, unread: true }, "unread"],
    [{ ...idle, unread: true, running: true }, "running"],
    [{ ...idle, unread: true, background: true }, "background"],
    [{ ...idle, running: true, background: true }, "running"],
    [{ ...idle, running: true, needsAttention: true }, "attention"],
    [{ ...idle, unread: true, needsAttention: true }, "attention"],
  ] as const)("%j shows %s", (input, expected) => {
    expect(resolveSidebarRowStatus(input)).toBe(expected);
  });
});

describe("resolveSidebarRowRestingStatus", () => {
  test.each([
    [{ hasDraft: false, snoozedUntil: null }, null],
    [{ hasDraft: false, snoozedUntil: "2026-11-05T09:00:00.000Z" }, "snoozed"],
    [{ hasDraft: true, snoozedUntil: null }, "draft"],
    [{ hasDraft: true, snoozedUntil: "2026-11-05T09:00:00.000Z" }, "draft"],
  ] as const)("%j rests on %s", (input, expected) => {
    expect(resolveSidebarRowRestingStatus(input)).toBe(expected);
  });
});

describe("resolveSidebarGroupStatus", () => {
  const quiet = { needsAttention: false, unread: false, running: false };

  test.each([
    [{ ...quiet }, null],
    [{ ...quiet, running: true }, "running"],
    [{ ...quiet, unread: true, running: true }, "unread"],
    [{ ...quiet, needsAttention: true, unread: true, running: true }, "attention"],
  ] as const)("%j shows %s", (input, expected) => {
    expect(resolveSidebarGroupStatus(input)).toBe(expected);
  });
});

describe("nativeThreadWaitsOnPerson", () => {
  test.each([
    [[], false],
    [["waitingOnApproval"], true],
    [["waitingOnUserInput"], true],
  ] as const)("%j waits: %s", (flags, expected) => {
    expect(nativeThreadWaitsOnPerson(flags)).toBe(expected);
  });
});

describe("sidebar thread row live view", () => {
  const item: CodexSidebarThreadItem = {
    key: "local:session:session-1",
    kind: "local",
    backendBinding: { driver: "codex", instanceId: "codex" },
    runLocation: { kind: "local-checkout" },
    hostId: "local",
    threadId: "session-1",
    parentThreadId: null,
    sessionId: "session-1",
    projectId: "project-1",
    title: "Delegate review",
    preview: "",
    cwd: null,
    updatedAt: 1,
    createdAt: 1,
    pinned: false,
    pinnedOrder: null,
    unread: false,
    snoozedUntil: null,
    snoozedAt: null,
    wokeAt: null,
    archived: false,
    statusType: "notLoaded",
    statusActiveFlags: [],
    projectless: false,
    disabled: false,
  };

  describe("projectSidebarThreadRowLiveView", () => {
    test("keeps native rows on their Core thread status", () => {
      expect(projectSidebarThreadRowLiveView({ ...item, statusType: "active" }, null)).toEqual({
        item: { ...item, statusType: "active" },
        running: true,
        background: false,
        needsAttention: false,
        readback: null,
        approvalPrompt: null,
        status: "running",
      });
    });

    test("carries a Runtime Run's approval prompt for the row to show", () => {
      const view = projectSidebarThreadRowLiveView(item, {
        indicator: "approval",
        location: null,
        approvalPrompt: "Run pnpm install?",
      });
      expect([view.needsApproval, view.approvalPrompt]).toEqual([true, "Run pnpm install?"]);
    });

    test("shows a native thread asking for approval or input as waiting, not working", () => {
      const statuses = (["waitingOnApproval", "waitingOnUserInput"] as const).map(
        (flag) =>
          projectSidebarThreadRowLiveView(
            { ...item, statusType: "active", statusActiveFlags: [flag] },
            null,
          ).status,
      );
      expect(statuses).toEqual(["attention", "attention"]);
    });

    test("shows Runtime running, waiting and background states from Session activity", () => {
      const states = (["running", "waiting", "background", null] as const).map((indicator) => {
        const view = projectSidebarThreadRowLiveView(item, { indicator, location: null });
        return [view.running, view.needsAttention, view.background];
      });
      expect(states).toEqual([
        [true, false, false],
        [false, true, false],
        [false, false, true],
        [false, false, false],
      ]);
    });

    test("applies the Runtime location so worktree rows show their glyph and working directory", () => {
      const worktree = projectSidebarThreadRowLiveView(item, {
        indicator: null,
        location: {
          hostId: "local",
          cwd: "/managed/feature/app",
          managedWorktreePath: "/managed/feature",
        },
      });
      expect(worktree.item.cwd).toBe("/managed/feature/app");
      expect(worktree.item.runLocation).toEqual({
        kind: "local-worktree",
        path: "/managed/feature",
        phase: "ready",
      });
      const checkout = projectSidebarThreadRowLiveView(
        { ...item, runLocation: { kind: "local-worktree", path: "/stale", phase: "ready" } },
        { indicator: null, location: { hostId: "local", cwd: "/repo", managedWorktreePath: null } },
      );
      expect(checkout.item.runLocation).toEqual({ kind: "local-checkout" });
    });
  });
});
