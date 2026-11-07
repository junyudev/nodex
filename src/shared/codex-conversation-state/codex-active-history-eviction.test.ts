import { describe, expect, test, vi } from "vite-plus/test";
import { produce, type Draft } from "immer";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalItem,
} from "./codex-conversation-state";
import { buildActiveHistoryFixture } from "./test-fixtures/active-history";
import {
  applyCodexActiveHistoryEviction,
  CODEX_ACTIVE_HISTORY_PROTECTED_ITEM_TYPES,
  CodexActiveHistoryWindow,
  isCodexActiveHistoryItemEvictable,
  planCodexActiveHistoryEviction,
  type CodexActiveHistoryCapabilities,
  type CodexActiveHistoryWindowOptions,
} from "./codex-active-history-eviction";
import type { CodexHistoryViewportBoundary } from "../codex-history-policy";

const fixture = buildActiveHistoryFixture;

const capabilities: CodexActiveHistoryCapabilities = {
  supportsThreadItemAnchors: true,
  supportsPaginatedThreadHistory: true,
  isFollower: false,
  hasFollowersOrPendingReconnect: false,
};
const viewingTurn = (
  turnId: string,
  firstProtectedItemId: string | null = null,
): readonly CodexHistoryViewportBoundary[] => [
  { oldestProtectedTurnId: turnId, firstProtectedItemId },
];
const plan = (
  state: CodexCanonicalConversationState | null,
  boundaries: readonly (CodexHistoryViewportBoundary | null)[] = [],
  overrides: Partial<CodexActiveHistoryCapabilities> = {},
) => planCodexActiveHistoryEviction(state, boundaries, { ...capabilities, ...overrides });
function release(
  state: CodexCanonicalConversationState,
  boundaries: readonly (CodexHistoryViewportBoundary | null)[] = [],
  cursor: string | null = "older-turns",
): CodexCanonicalConversationState {
  const selected = plan(state, boundaries);
  if (!selected) throw new Error("Expected a release plan");
  return produce(state, (draft) => applyCodexActiveHistoryEviction(draft, selected, cursor));
}
const turn = (state: CodexCanonicalConversationState, entityKey = "entity-0") =>
  state.turnHistory!.history.entitiesByKey[entityKey]!;
const itemIds = (state: CodexCanonicalConversationState, entityKey = "entity-0") =>
  turn(state, entityKey).items.map(({ id }) => id);
const replaceItem = (
  state: CodexCanonicalConversationState,
  index: number,
  item: { readonly type: string; readonly id: string },
) =>
  produce(state, (draft) => {
    draft.turnHistory!.history.entitiesByKey["entity-0"]!.items[index] =
      item as Draft<CodexCanonicalItem>;
  });

describe("active history retention", () => {
  test("1000 items stay resident; the 1001st releases a prefix down to 500", () => {
    expect(plan(fixture([1000]), viewingTurn("turn-0", "item-0-999"))).toBeNull();
    expect(plan(fixture([1001]), viewingTurn("turn-0", "item-0-501"))?.itemCuts).toEqual([
      { entityKey: "entity-0", end: 501, retained: new Set() },
    ]);
  });

  test("a long running Turn keeps its final 500 items and anchors older history to the first", () => {
    const before = produce(fixture(), (draft) => {
      draft.turnHistory!.history.entitiesByKey["entity-0"]!.status = "inProgress";
    });
    const after = release(before, viewingTurn("turn-0", "item-0-1000"));
    expect(turn(after).items).toHaveLength(500);
    expect(turn(after).items[0]!.id).toBe("item-0-1000");
    expect(turn(after).completedItemIds?.["item-0-999"]).toBeUndefined();
    expect(turn(after).completedItemIds?.["item-0-1000"]).toBe(true);
    expect(turn(after).itemsPagination).toMatchObject({
      olderCursor: { type: "item", itemId: "item-0-1000" },
      itemsView: "summary",
      hasLoadedOldest: false,
    });
    expect(turn(after).itemsPagination?.olderPageBeforeItemId).toBeUndefined();
    expect(turn(before).items).toHaveLength(1500);
  });

  test("released items take their per-item timing and lifecycle evidence with them", () => {
    const before = produce(fixture(), (draft) => {
      const value = draft.turnHistory!.history.entitiesByKey["entity-0"]!;
      value.assistantMessageStartedAtMsById = { "item-0-0": 1, "item-0-1400": 2 };
      value.commandExecutionStartedAtMsById = { "item-0-0": 1 };
      value.lifecycleStatusByItemId = { "item-0-0": "completed" };
      value.interruptedCommandExecutionItemIds = ["item-0-0", "item-0-1400"];
    });
    const after = turn(release(before));
    expect(after.assistantMessageStartedAtMsById).toEqual({ "item-0-1400": 2 });
    expect(after.commandExecutionStartedAtMsById).toBeUndefined();
    expect(after.lifecycleStatusByItemId).toBeUndefined();
    expect(after.interruptedCommandExecutionItemIds).toEqual(["item-0-1400"]);
  });

  test("whole settled Turns leave the topology, behind a loadable boundary", () => {
    const before = fixture([300, 300, 300, 300]);
    const after = release(before);
    const history = after.turnHistory!.history;
    expect(history.islands[0]!.entries.map(({ value }) => value)).toEqual(["entity-2", "entity-3"]);
    expect(history.entitiesByKey["entity-0"]).toBeUndefined();
    expect(history.entitiesByKey["entity-1"]).toBeUndefined();
    expect(history.generation).toBe(2);
    expect(history.isComplete).toBe(false);
    expect(history.islands[0]!.olderBoundary).toMatchObject({
      status: "available",
      handle: { cursor: "older-turns", oldestLoadedTurnId: "turn-2" },
    });
    expect(after.turnsPagination).toMatchObject({
      olderCursor: "older-turns",
      oldestLoadedTurnId: "turn-2",
      hasLoadedOldest: false,
    });
    expect(itemIds(after, "entity-2")).toHaveLength(200);
    expect(turn(after, "entity-3")).toBe(turn(before, "entity-3"));
  });

  test("a Turn released whole after a partial one leaves the older part in its own island", () => {
    const before = produce(fixture([50, 400, 600, 100]), (draft) => {
      draft.turnHistory!.history.entitiesByKey["entity-0"]!.hookRuns = [{ id: "hook" } as never];
    });
    const after = release(before);
    const history = after.turnHistory!.history;
    expect(history.islands.map(({ entries }) => entries.map(({ value }) => value))).toEqual([
      ["entity-0"],
      ["entity-2", "entity-3"],
    ]);
    expect(history.islands[0]).toMatchObject({
      olderBoundary: { status: "exhausted" },
      newerBoundary: { status: "exhausted" },
    });
    expect(history.islands[1]!.olderBoundary).toMatchObject({
      status: "available",
      handle: { cursor: "older-turns", oldestLoadedTurnId: "turn-2" },
    });
    expect(itemIds(after)).toEqual(["item-0-49"]);
    expect(after.turnsPagination).toEqual(before.turnsPagination);
  });

  test("no viewer lets a background conversation stay bounded; any veto stops it", () => {
    const state = fixture();
    expect(plan(state, [])).not.toBeNull();
    expect(plan(state, [null])).toBeNull();
    expect(plan(state, [...viewingTurn("turn-0", "item-0-1000"), null])).toBeNull();
    expect(plan(state, viewingTurn("unknown"))).toBeNull();
    expect(plan(state, viewingTurn("turn-0", "unknown"))).toBeNull();
  });

  test("all viewers protect their earliest position", () => {
    expect(
      plan(fixture(), [
        ...viewingTurn("turn-0", "item-0-900"),
        ...viewingTurn("turn-0", "item-0-400"),
      ])?.itemCuts,
    ).toEqual([{ entityKey: "entity-0", end: 400, retained: new Set() }]);
    expect(plan(fixture([1500, 100]), viewingTurn("turn-0"))).toBeNull();
  });

  test("a viewer reading an older island does not stop the live tail from being bounded", () => {
    const state = produce(fixture([1200]), (draft) => {
      const history = draft.turnHistory!.history;
      history.entitiesByKey["older-entity"] = {
        ...history.entitiesByKey["entity-0"]!,
        turnId: "older-turn",
        items: [],
      };
      history.islands.unshift({
        id: "older-island",
        entries: [{ key: "older-entity", value: "older-entity" }],
        olderBoundary: { status: "exhausted", boundaryId: "older-island:older" },
        newerBoundary: { status: "opaque", boundaryId: "older-island:newer" },
      });
      history.islands[1]!.olderBoundary = { status: "opaque", boundaryId: "island:older" };
    });
    expect(plan(state, viewingTurn("older-turn"))?.itemCuts).toEqual([
      { entityKey: "entity-0", end: 700, retained: new Set() },
    ]);
  });

  test("a live tail split from its history is not this window's to release", () => {
    const state = produce(fixture(), (draft) => {
      draft.turnHistory!.history.islands[0]!.newerBoundary = {
        status: "opaque",
        boundaryId: "newer",
      };
    });
    expect(plan(state)).toBeNull();
  });

  test.each([...CODEX_ACTIVE_HISTORY_PROTECTED_ITEM_TYPES, "autoReviewInterruptionWarning"])(
    "%s keeps its place and the item before it while later history is released around it",
    (type) => {
      const before = replaceItem(fixture(), 100, { type, id: "unsafe" });
      const prefix = plan(before);
      expect(prefix?.itemCuts).toEqual([{ entityKey: "entity-0", end: 99, retained: new Set() }]);
      const blockedAtStart = replaceItem(fixture(), 1, { type, id: "unsafe" });
      const gaps = release(blockedAtStart);
      expect(itemIds(gaps).slice(0, 2)).toEqual(["item-0-0", "unsafe"]);
      expect(itemIds(gaps)).toHaveLength(502);
      expect(turn(gaps).itemsPagination).toMatchObject({
        olderCursor: { type: "item", itemId: "item-0-1000" },
        olderPageBeforeItemId: "item-0-1000",
      });
    },
  );

  test("running Turns require explicit completion for every released item", () => {
    const withoutEvidence = produce(fixture(), (draft) => {
      delete draft.turnHistory!.history.entitiesByKey["entity-0"]!.completedItemIds;
    });
    expect(plan(withoutEvidence)?.itemCuts).toEqual([
      { entityKey: "entity-0", end: 1000, retained: new Set() },
    ]);
    const running = produce(withoutEvidence, (draft) => {
      draft.turnHistory!.history.entitiesByKey["entity-0"]!.status = "inProgress";
    });
    expect(plan(running)).toBeNull();
    const falseEvidence = produce(fixture(), (draft) => {
      const value = draft.turnHistory!.history.entitiesByKey["entity-0"]!;
      value.status = "inProgress";
      value.completedItemIds!["item-0-20"] = false;
    });
    expect(plan(falseEvidence)?.itemCuts).toEqual([
      { entityKey: "entity-0", end: 19, retained: new Set() },
    ]);
  });

  test("in-progress and explicitly incomplete items are unsafe in every Turn", () => {
    const base = turn(fixture());
    expect(
      isCodexActiveHistoryItemEvictable(
        {
          ...base,
          items: [
            { type: "commandExecution", id: "command", status: "inProgress" } as CodexCanonicalItem,
          ],
        },
        0,
      ),
    ).toBe(false);
    expect(
      isCodexActiveHistoryItemEvictable(
        { ...base, items: [{ type: "contextCompaction", id: "compact", completed: false }] },
        0,
      ),
    ).toBe(false);
  });

  test("pending requests, transient state and foreign conversations prevent release", () => {
    const base = fixture();
    for (const state of [
      { ...base, rolloutPath: "" },
      { ...base, ephemeral: true },
      { ...base, resumeState: "resuming" as const },
      { ...base, historyMode: "legacy" as const },
      { ...base, turns: [turn(base)] },
      { ...base, itemTimeline: { entries: [] } as never },
      {
        ...base,
        turnsPagination: {
          source: "timeline" as const,
          olderCursor: null,
          oldestLoadedTurnId: null,
          isLoadingOlder: false,
          hasLoadedOldest: true,
        },
      },
      {
        ...base,
        requests: [
          {
            id: "request",
            method: "item/plan/requestImplementation",
            params: { threadId: "thread", turnId: "turn-0", planContent: "plan" },
          },
        ],
      } as CodexCanonicalConversationState,
    ])
      expect(plan(state)).toBeNull();
    for (const extra of [
      { isLoadingOlder: true },
      { summaryItemIds: [] },
      { reconnect: { beforeItemId: null, stopItemId: null } },
    ]) {
      const state = produce(base, (draft) => {
        draft.turnHistory!.history.entitiesByKey["entity-0"]!.itemsPagination = {
          itemsView: "full",
          olderCursor: null,
          isLoadingOlder: false,
          hasLoadedOldest: true,
          ...extra,
        };
      });
      expect(plan(state)).toBeNull();
    }
    for (const override of [
      { supportsThreadItemAnchors: false },
      { supportsPaginatedThreadHistory: false },
      { isFollower: true },
      { hasFollowersOrPendingReconnect: true },
    ])
      expect(plan(base, [], override)).toBeNull();
  });

  test("a plan computed before the topology moved changes nothing", () => {
    const state = fixture([300, 300, 300, 300]);
    const selected = plan(state)!;
    const moved = produce(state, (draft) => {
      draft.turnHistory!.history.generation += 1;
    });
    const after = produce(moved, (draft) =>
      applyCodexActiveHistoryEviction(draft, selected, "older"),
    );
    expect(after).toBe(moved);
  });
});

describe("active history window", () => {
  function harness(initial: CodexCanonicalConversationState) {
    let state = initial;
    const scheduled: Array<() => void> = [];
    const turnPages: Array<{ data: readonly { id: string }[]; nextCursor: string | null }> = [];
    let activeRead: Promise<unknown> | undefined;
    const sendRequest = vi.fn(async () => turnPages.shift() ?? { data: [], nextCursor: null });
    const options: CodexActiveHistoryWindowOptions = {
      client: {
        getConversation: () => state,
        updateConversation: (_id, recipe) => {
          state = produce(state, recipe);
        },
        sendRequest: sendRequest as never,
      },
      capabilities: () => capabilities,
      getActiveRead: () => activeRead,
      schedule: (work) => {
        scheduled.push(work);
        return () => scheduled.splice(scheduled.indexOf(work), 1);
      },
      onError: vi.fn(),
    };
    const flush = async () => {
      for (let round = 0; round < 8; round += 1) {
        const work = scheduled.shift();
        work?.();
        await new Promise((resolve) => setTimeout(resolve));
      }
    };
    return {
      window: new CodexActiveHistoryWindow(options),
      read: () => state,
      scheduled,
      turnPages,
      sendRequest,
      setActiveRead: (read: Promise<unknown> | undefined) => {
        activeRead = read;
      },
      flush,
      onError: options.onError,
    };
  }

  test("returns a growing conversation to the target, one pass at a time", async () => {
    const f = harness(fixture([1500]));
    f.window.enforce("thread");
    f.window.enforce("thread");
    expect(f.scheduled).toHaveLength(1);
    await f.flush();
    expect(turn(f.read()).items).toHaveLength(500);
    expect(f.sendRequest).not.toHaveBeenCalled();
    expect(f.scheduled).toHaveLength(0);
  });

  test("finds the older-Turn cursor by reading past the Turns that stay", async () => {
    const f = harness(fixture([300, 300, 300, 300]));
    f.turnPages.push({ data: [{ id: "turn-3" }, { id: "turn-2" }], nextCursor: "before-turn-2" });
    f.window.enforce("thread");
    await f.flush();
    expect(f.sendRequest).toHaveBeenCalledWith(
      "thread/turns/list",
      {
        threadId: "thread",
        cursor: null,
        limit: 2,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
      { priority: "background", source: "tail_history" },
    );
    expect(f.read().turnsPagination?.olderCursor).toBe("before-turn-2");
    expect(f.read().turnHistory!.history.islands[0]!.entries).toHaveLength(2);
  });

  test("keeps every Turn when the server's Turn list no longer matches", async () => {
    const f = harness(fixture([300, 300, 300, 300]));
    f.turnPages.push({ data: [{ id: "turn-3" }, { id: "elsewhere" }], nextCursor: "cursor" });
    f.window.enforce("thread");
    await f.flush();
    expect(f.read().turnHistory!.history.islands[0]!.entries).toHaveLength(4);
  });

  test("waits for a read in flight, whose response could rebuild what was released", async () => {
    const f = harness(fixture());
    let finish = () => {};
    f.setActiveRead(new Promise<void>((resolve) => (finish = resolve)));
    f.window.enforce("thread");
    await f.flush();
    expect(turn(f.read()).items).toHaveLength(1500);
    f.setActiveRead(undefined);
    finish();
    await f.flush();
    expect(turn(f.read()).items).toHaveLength(500);
  });

  test("a viewer re-evaluates only a conversation that was waiting on viewers", async () => {
    const f = harness(fixture());
    const viewer = Symbol();
    f.window.setViewport("thread", viewer, [null]);
    f.window.enforce("thread");
    await f.flush();
    expect(turn(f.read()).items).toHaveLength(1500);
    f.window.setViewport("thread", viewer, viewingTurn("turn-0", "item-0-1000"));
    await f.flush();
    expect(turn(f.read()).items).toHaveLength(500);
    const planned = vi.spyOn(f, "read");
    f.window.setViewport("thread", viewer, viewingTurn("turn-0", "item-0-1100"));
    expect(f.scheduled).toHaveLength(0);
    planned.mockRestore();
  });

  test("the last viewer leaving lets the conversation be bounded in the background", async () => {
    const f = harness(fixture());
    const viewer = Symbol();
    f.window.setViewport("thread", viewer, [null]);
    f.window.enforce("thread");
    await f.flush();
    expect(turn(f.read()).items).toHaveLength(1500);
    f.window.setViewport("thread", viewer, undefined);
    await f.flush();
    expect(turn(f.read()).items).toHaveLength(500);
  });

  test("disposal cancels a scheduled pass", async () => {
    const f = harness(fixture());
    f.window.enforce("thread");
    f.window.dispose();
    await f.flush();
    expect(turn(f.read()).items).toHaveLength(1500);
    f.window.enforce("thread");
    expect(f.scheduled).toHaveLength(0);
  });
});
