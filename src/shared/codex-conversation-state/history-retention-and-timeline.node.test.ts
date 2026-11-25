import { describe, expect, test, vi, it } from "vite-plus/test";
import { produce, type Draft, enablePatches, produceWithPatches } from "immer";
import {
  type CodexCanonicalConversationState,
  type CodexCanonicalItem,
  type CodexCanonicalItemTimeline,
  type CodexCanonicalTimelineEntry,
  createCodexCanonicalHydratedConversationState,
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
import {
  mergeCodexAnchoredHistoryItems,
  mergeCodexCanonicalHistoryItems,
} from "./codex-history-item-merge";
import { agentActivityV2WebSearchItem } from "./test-fixtures/agent-activity-v2-item-family-corpus";
import {
  applyCodexHistoryItemWindowMutation,
  createCodexHistoryItemWindow,
  materializeCodexHistoryItemWindow,
  prependCodexHistoryItemPage,
  type CodexHistoryItemSegment,
  type CodexHistoryItemWindow,
} from "./codex-history-item-window";
import {
  measureCodexHistoryResidency,
  availableCodexHistoryBoundary,
  createCodexHistoryBoundaryRef,
  readCurrentCodexHistoryBoundary,
  createCodexHistoryIslandTopology,
  createEmptyCodexHistoryTopology,
  exhaustedCodexHistoryBoundary,
  flattenCodexHistoryTopology,
  insertCodexHistoryIsland,
  mergeCodexHistoryBoundaryPage,
  replaceCodexHistoryEntity,
  validateCodexHistoryTopology,
  type CodexHistoryBoundary,
  type CodexHistoryEntity,
  type CodexHistoryEntry,
} from "./codex-history-topology";
import type { Turn as ProtocolTurn, ThreadRealtimeItem } from "@nodex/codex-app-server-protocol/v2";
import { CodexItemTimelineIndex } from "./codex-item-timeline-index";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import { reduceCodexConversationEvent } from "./codex-conversation-reducer";

describe("codex active history eviction", () => {
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
      expect(history.islands[0]!.entries.map(({ value }) => value)).toEqual([
        "entity-2",
        "entity-3",
      ]);
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
              {
                type: "commandExecution",
                id: "command",
                status: "inProgress",
              } as CodexCanonicalItem,
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
          // oxlint-disable-next-line nodex/no-real-time-wait-in-tests -- Each pass schedules its successor from the settled native-read promise.
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
});

describe("codex history item merge", () => {
  const answer = (
    id: string,
    text = id,
  ): Extract<CodexCanonicalItem, { type: "agentMessage" }> => ({
    type: "agentMessage",
    moderation: null,
    id,
    text,
    phase: "final_answer",
    memoryCitation: null,
    questions: null,
    delivery: null,
  });

  describe("history item merge", () => {
    it.each([false, true])(
      "retains web results when either copy of an overlapping item has them (incoming preferred %s)",
      (preferIncomingItems) => {
        const search = agentActivityV2WebSearchItem;
        const sparse = { ...search, results: null };
        const options = { preferIncomingItems };
        expect(
          mergeCodexCanonicalHistoryItems([sparse], [search], "append", options).items,
        ).toEqual([search]);
        expect(
          mergeCodexCanonicalHistoryItems([search], [sparse], "append", options).items,
        ).toEqual([search]);
      },
    );

    it.each([false, true])(
      "preserves steer acceptance across an overlapping merge (incoming %s)",
      (preferIncomingItems) => {
        const pending: Extract<CodexCanonicalItem, { type: "steeringUserMessage" }> = {
          type: "steeringUserMessage",
          id: "queued",
          status: "pending",
          targetTurnId: "turn",
          targetTurnStartedAtMs: null,
          clientUserMessageId: "client",
          input: [{ type: "text", text: "captured", text_elements: [] }],
          attachments: [],
          restoreMessage: { context: { commentAttachments: ["current"] } },
          compareKey: { rawText: "captured", imageCount: 0 },
        };
        const accepted = {
          ...pending,
          status: "accepted" as const,
          serverUserMessageId: "native-user",
          acceptedInput: pending.input,
          restoreMessage: { context: { commentAttachments: ["old history"] } },
        };
        const options = { preferIncomingItems };
        const merged = mergeCodexCanonicalHistoryItems([pending], [accepted], "append", options)
          .items[0]!;
        expect(merged).toEqual({
          ...pending,
          status: "accepted",
          serverUserMessageId: "native-user",
          acceptedInput: pending.input,
        });
        const ackOnly = { ...pending, status: "accepted" as const };
        expect(
          mergeCodexCanonicalHistoryItems([ackOnly], [accepted], "append", options).items[0],
        ).toEqual(merged);
        expect(
          mergeCodexCanonicalHistoryItems([merged], [pending], "prepend", options).items[0],
        ).toBe(merged);
        for (const foreign of [
          { ...accepted, clientUserMessageId: "another-client" },
          { ...accepted, targetTurnId: "another-turn" },
          { ...accepted, targetTurnStartedAtMs: 10 },
          {
            ...accepted,
            input: [{ type: "text" as const, text: "old edited input", text_elements: [] }],
          },
        ])
          expect(
            mergeCodexCanonicalHistoryItems([pending], [foreign], "append", options).items[0],
          ).toBe(pending);
      },
    );
    it("places new items around resident anchors while retaining newer live values", () => {
      const resident = [
        { id: "b", value: "live" },
        { id: "d", value: "live" },
      ];
      const incoming = ["a", "b", "c", "d", "e"].map((id) => ({ id, value: "history" }));
      const merged = mergeCodexAnchoredHistoryItems(
        resident,
        incoming,
        (item) => item.id,
        "prepend",
      );
      expect(merged.map((item) => item.id)).toEqual(["a", "b", "c", "d", "e"]);
      expect(merged[1]).toBe(resident[0]);
      expect(merged[3]).toBe(resident[1]);
    });

    it.each(["prepend", "append"] as const)(
      "%s preserves disjoint incoming occurrences",
      (direction) => {
        const result = mergeCodexAnchoredHistoryItems(
          ["resident"],
          ["a", "a", "b"],
          (item) => item,
          direction,
        );
        expect(result).toEqual(
          direction === "prepend" ? ["a", "a", "b", "resident"] : ["resident", "a", "a", "b"],
        );
      },
    );

    it("coalesces a renamed final answer into its existing identity and retains its citation", () => {
      const original = {
        ...answer("local", "same answer"),
        memoryCitation: { entries: [], threadIds: ["rollout"] },
      } as CodexCanonicalItem;
      const result = mergeCodexCanonicalHistoryItems(
        [original],
        [answer("persisted", "same answer")],
        "prepend",
      );
      expect(result.items).toEqual([original]);
      expect(result.aliases.get("persisted")).toBe("local");
    });

    it("keeps a final answer's citation and moderation when a refreshed copy omits them", () => {
      const resident = {
        ...answer("answer"),
        memoryCitation: { entries: [], threadIds: ["rollout"] },
        moderation: {
          moderated: true,
          display: { mode: "block", version: 1, reason: { kind: "cyber" } },
        },
      } as CodexCanonicalItem;
      const refreshed = answer("answer");
      const result = mergeCodexCanonicalHistoryItems([resident], [refreshed], "prepend", {
        preferIncomingItems: true,
      });
      expect(result.items).toEqual([resident]);
      const unchanged = mergeCodexCanonicalHistoryItems([refreshed], [refreshed], "prepend", {
        preferIncomingItems: true,
      });
      expect(unchanged.items[0]).toBe(refreshed);
    });

    it("applies a final-answer alias to every incoming occurrence", () => {
      const resident = answer("local", "same");
      const result = mergeCodexCanonicalHistoryItems(
        [resident],
        [answer("persisted", "same"), answer("persisted", "same")],
        "prepend",
      );
      expect(result.items).toEqual([resident]);
      expect(result.aliases.get("persisted")).toBe("local");
    });

    it("does not coalesce distinct final answers or commentary with matching text", () => {
      const original = answer("first", "same");
      const commentary = {
        ...answer("commentary", "same"),
        phase: "commentary",
      } as CodexCanonicalItem;
      const result = mergeCodexCanonicalHistoryItems(
        [original],
        [commentary, answer("second", "different")],
        "prepend",
      );
      expect(result.items.map((item) => item.id)).toEqual(["commentary", "second", "first"]);
      expect(result.aliases.size).toBe(0);
    });
  });
});

describe("codex history item window", () => {
  interface CanonicalItem {
    readonly id: string;
    readonly text: string;
  }

  interface RendererItem {
    readonly entryId: string;
    readonly text: string;
  }

  const available = (cursor: string | null) => ({ status: "available" as const, cursor });

  function segment(
    segmentId: string,
    itemIds: readonly string[],
    approximateBytes = itemIds.length * 32,
    turnId = "turn-a",
  ): CodexHistoryItemSegment<CanonicalItem, RendererItem> {
    return {
      segmentId,
      turnId,
      items: {
        itemIds,
        canonicalItems: itemIds.map((id) => ({ id, text: `canonical:${id}` })),
        rendererItems: itemIds.map((id) => ({ entryId: `entry:${id}`, text: `renderer:${id}` })),
      },
      approximateBytes,
    };
  }

  function createWindow(input?: {
    readonly maxItems?: number;
    readonly maxApproximateBytes?: number;
    readonly olderCursor?: string | null;
    readonly seedSegments?: readonly CodexHistoryItemSegment<CanonicalItem, RendererItem>[];
  }): CodexHistoryItemWindow<CanonicalItem, RendererItem> {
    const created = createCodexHistoryItemWindow<CanonicalItem, RendererItem>({
      turnId: "turn-a",

      olderBoundary: available(input?.olderCursor ?? "cursor:before"),
      seedSegments: input?.seedSegments,
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.window;
  }

  describe("Codex history item window", () => {
    it("materializes seeded canonical and renderer segments only at the explicit view seam", () => {
      const window = createWindow({
        seedSegments: [segment("older", ["a", "b"]), segment("newer", ["c"])],
      });

      expect(window.residency).toEqual({
        segmentCount: 2,
        itemCount: 3,
        approximateBytes: 96,
      });
      const materialized = materializeCodexHistoryItemWindow(window);
      expect(materialized.segments.map(({ segmentId }) => segmentId)).toEqual(["older", "newer"]);
      expect(materialized.itemIds).toEqual(["a", "b", "c"]);
      expect(materialized.canonicalItems.map(({ id }) => id)).toEqual(["a", "b", "c"]);
      expect(materialized.rendererItems.map(({ entryId }) => entryId)).toEqual([
        "entry:a",
        "entry:b",
        "entry:c",
      ]);
      expect(materialized.work).toEqual({
        segmentsVisited: 2,
        itemIdsVisited: 3,
        canonicalItemsVisited: 3,
        rendererItemsVisited: 3,
      });
    });

    it("fails closed on foreign, duplicate, mismatched, and stalled pages", () => {
      const before = createWindow({ seedSegments: [segment("seed", ["resident"])] });
      const cases = [
        prependCodexHistoryItemPage(before, {
          ...segment("foreign", ["foreign"], 32, "turn-other"),
          olderCursorAfter: "cursor:next",
        }),
        prependCodexHistoryItemPage(before, {
          ...segment("seed", ["new"]),
          olderCursorAfter: "cursor:next",
        }),
        prependCodexHistoryItemPage(before, {
          ...segment("duplicate-resident", ["resident"]),
          olderCursorAfter: "cursor:next",
        }),
        prependCodexHistoryItemPage(before, {
          ...segment("duplicate-page", ["same", "same"]),
          olderCursorAfter: "cursor:next",
        }),
        prependCodexHistoryItemPage(before, {
          turnId: "turn-a",
          segmentId: "mismatch",
          items: {
            itemIds: ["declared"],
            canonicalItems: [{ id: "actual", text: "mismatch" }],
            rendererItems: [],
          },
          approximateBytes: 1,
          olderCursorAfter: "cursor:next",
        }),
        prependCodexHistoryItemPage(before, {
          ...segment("stalled", ["new"]),
          olderCursorAfter: "cursor:before",
        }),
      ];

      expect(cases.map((result) => (result.ok ? "ok" : result.error.code))).toEqual([
        "foreignTurn",
        "duplicateSegment",
        "duplicateItem",
        "duplicateItem",
        "malformedIdentity",
        "cursorStalled",
      ]);
      expect(materializeCodexHistoryItemWindow(before).itemIds).toEqual(["resident"]);
      expect(before.olderBoundary).toEqual(available("cursor:before"));
    });

    it("advances an empty page cursor without adding a resident segment", () => {
      const before = createWindow({ seedSegments: [segment("seed", ["resident"])] });
      const result = prependCodexHistoryItemPage(before, {
        ...segment("empty", []),
        olderCursorAfter: "cursor:next",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.window.olderBoundary).toEqual(available("cursor:next"));
      expect(result.window.residency).toEqual(before.residency);
      expect(materializeCodexHistoryItemWindow(result.window).itemIds).toEqual(["resident"]);
    });

    it("serializes only the admitted page without reading unchanged resident item payloads", () => {
      let unchangedPayloadReads = 0;
      const unchangedCanonical = {
        id: "resident",
        get text() {
          unchangedPayloadReads += 1;
          return "resident payload";
        },
      };
      const created = createCodexHistoryItemWindow<typeof unchangedCanonical, RendererItem>({
        turnId: "turn-a",

        olderBoundary: available("cursor:before"),
        seedSegments: [
          {
            segmentId: "seed",
            turnId: "turn-a",
            items: {
              itemIds: ["resident"],
              canonicalItems: [unchangedCanonical],
              rendererItems: [{ entryId: "entry:resident", text: "resident" }],
            },
            approximateBytes: 32,
          },
        ],
      });
      if (!created.ok) throw new Error(created.error.message);
      unchangedPayloadReads = 0;

      const transition = prependCodexHistoryItemPage(created.window, {
        turnId: "turn-a",
        segmentId: "page",
        items: {
          itemIds: ["older"],
          canonicalItems: [{ id: "older", text: "older payload" }],
          rendererItems: [{ entryId: "entry:older", text: "older" }],
        },
        approximateBytes: 32,
        olderCursorAfter: "cursor:next",
      });
      if (!transition.ok) throw new Error(transition.error.message);
      const encoded = JSON.stringify({
        wireSegment: transition.wireSegment,
      });

      expect(encoded).toContain("older payload");
      expect(encoded).not.toContain("resident payload");
      expect(JSON.stringify(transition.window)).not.toContain("resident payload");
      expect(unchangedPayloadReads).toBe(0);
      expect(transition.work.residentItemsMaterialized).toBe(0);
    });

    it("keeps 10k repeated page merge, wire serialization, and receiver apply page-bounded", () => {
      const createStressWindow = () => {
        const created = createCodexHistoryItemWindow<CanonicalItem, RendererItem>({
          turnId: "turn-stress",

          olderBoundary: available(null),
        });
        if (!created.ok) throw new Error(created.error.message);
        return created.window;
      };
      let source = createStressWindow();
      let receiver = createStressWindow();
      let maxWireBytes = 0;
      let maxIndexNodeVisits = 0;

      for (let pageIndex = 0; pageIndex < 10_000; pageIndex += 1) {
        const itemId = `item-${pageIndex}`;
        const transition = prependCodexHistoryItemPage(source, {
          turnId: "turn-stress",
          segmentId: `segment-${pageIndex}`,
          items: {
            itemIds: [itemId],
            canonicalItems: [{ id: itemId, text: "canonical" }],
            rendererItems: [{ entryId: `entry-${pageIndex}`, text: "renderer" }],
          },
          approximateBytes: 32,
          olderCursorAfter: pageIndex === 9_999 ? null : `cursor-${pageIndex + 1}`,
        });
        if (!transition.ok) throw new Error(transition.error.message);
        source = transition.window;

        const encoded = JSON.stringify({
          wireSegment: transition.wireSegment,
        });
        maxWireBytes = Math.max(maxWireBytes, encoded.length);
        maxIndexNodeVisits = Math.max(
          maxIndexNodeVisits,
          transition.work.itemIndexNodeVisits + transition.work.segmentIndexNodeVisits,
        );
        expect(transition.work.pageItemsVisited).toBe(1);
        expect(transition.work.pageRendererItemsVisited).toBe(1);
        expect(transition.work.residentItemsMaterialized).toBe(0);
        expect(transition.work.wireValues).toBe(3);
        expect(source.residency.itemCount).toBe(pageIndex + 1);
        expect(source.residency.approximateBytes).toBe((pageIndex + 1) * 32);

        const applied = applyCodexHistoryItemWindowMutation(receiver, {
          wireSegment: transition.wireSegment,
        });
        if (!applied.ok) throw new Error(applied.error.message);
        receiver = applied.window;
        expect(applied.work.residentItemsMaterialized).toBe(0);
        expect(receiver.residency).toEqual(source.residency);
      }

      expect(maxWireBytes).toBeLessThan(600);
      expect(maxIndexNodeVisits).toBeLessThan(80);
      expect(source.residency).toEqual({
        segmentCount: 10_000,
        itemCount: 10_000,
        approximateBytes: 320_000,
      });
      expect(source.olderBoundary).toEqual({ status: "exhausted" });
      expect(source.newerBoundary).toEqual({ status: "exhausted" });
      expect(receiver.olderBoundary).toEqual(source.olderBoundary);
      expect(receiver.newerBoundary).toEqual(source.newerBoundary);
      const materialized = materializeCodexHistoryItemWindow(source);
      expect(materialized.itemIds).toHaveLength(10_000);
      expect(materialized.itemIds[0]).toBe("item-9999");
      expect(materialized.itemIds.at(-1)).toBe("item-0");
      expect(materialized.work.itemIdsVisited).toBe(10_000);
    });
  });
});

describe("codex history topology", () => {
  type Turn = ProtocolTurn & {
    readonly itemsPagination: import("./codex-history-topology").CodexHistoryTurnItemsPagination;
  };

  function turn(id: string, itemsView: Turn["itemsView"] = "full"): Turn {
    return {
      rootTurnId: null,
      id,
      itemsPagination: {
        olderCursor: itemsView === "full" ? null : `items:${id}`,
        isLoadingOlder: false,
        hasLoadedOldest: itemsView === "full",
        itemsView,
      },
      items: [],
      itemsView,
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };
  }

  function entity(
    id: string,
    options: {
      readonly itemsView?: Turn["itemsView"];
      readonly durationMs?: number;
    } = {},
  ): CodexHistoryEntity<Turn> {
    const itemsView = options.itemsView ?? "full";
    return {
      key: id,
      turn: { ...turn(id, itemsView), durationMs: options.durationMs ?? null },
    };
  }

  function entry(id: string): CodexHistoryEntry {
    return { key: id, value: id };
  }

  function available(id: string, cursor = id): CodexHistoryBoundary {
    return availableCodexHistoryBoundary(id, { cursor, oldestLoadedTurnId: null });
  }

  function expectTopology<TTurn>(
    result: ReturnType<typeof createCodexHistoryIslandTopology<TTurn>>,
  ) {
    if (!result.ok) throw new Error(result.error.message);
    return result.topology;
  }

  describe("Codex sparse history topology", () => {
    test("represents an empty tail without inventing a gap", () => {
      const topology = createEmptyCodexHistoryTopology<Turn>(4);
      expect(topology).toMatchObject({
        generation: 4,
        isComplete: false,
        islands: [],
      });
      expect(flattenCodexHistoryTopology(topology)).toEqual([]);
    });

    test("keeps the completeness and boundaries of an empty fetched tail", () => {
      const complete = expectTopology(
        createCodexHistoryIslandTopology<Turn>({
          generation: 3,
          isComplete: true,
          islandId: "tail:3",
          entries: [],
          entities: [],
          olderBoundary: exhaustedCodexHistoryBoundary("tail:3:older"),
          newerBoundary: exhaustedCodexHistoryBoundary("tail:3:newer"),
        }),
      );
      expect(complete.isComplete).toBe(true);
      expect(complete.islands).toHaveLength(1);
      expect(flattenCodexHistoryTopology(complete)).toEqual([]);
      const incomplete = { ...complete, isComplete: false };
      expect(validateCodexHistoryTopology(incomplete)).toBeNull();
      expect(flattenCodexHistoryTopology(incomplete)).toEqual([]);
    });

    test("projects five tail turns after one inert older gap", () => {
      const ids = ["turn-6", "turn-7", "turn-8", "turn-9", "turn-10"];
      const topology = expectTopology(
        createCodexHistoryIslandTopology({
          generation: 2,
          islandId: "tail:2",
          entries: ids.map(entry),
          entities: ids.map((id) => entity(id)),
          olderBoundary: available("older:tail", "cursor:5"),
          newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
        }),
      );
      const rows = flattenCodexHistoryTopology(topology);
      expect(rows.map((row) => row.kind)).toEqual([
        "gap",
        "content",
        "content",
        "content",
        "content",
        "content",
      ]);
      expect(rows[0]).toMatchObject({ kind: "gap", estimatedHeightPx: 144, olderBoundary: null });
      expect(topology.isComplete).toBe(false);
      expect(measureCodexHistoryResidency(topology).turnCount).toBe(5);
    });

    test("prepends one page, advances the exact boundary, and preserves loaded identity", () => {
      const tail = expectTopology(
        createCodexHistoryIslandTopology({
          generation: 1,
          islandId: "tail:1",
          entries: [entry("turn-4"), entry("turn-5")],
          entities: [entity("turn-4"), entity("turn-5")],
          olderBoundary: available("older:tail", "cursor:3"),
          newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
        }),
      );
      const oldTurn = tail.entitiesByKey["turn-4"];
      const boundary = tail.islands[0]!.olderBoundary;
      if (boundary.status !== "available") throw new Error("expected available boundary");
      const result = mergeCodexHistoryBoundaryPage(tail, {
        boundary: createCodexHistoryBoundaryRef(1, "tail:1", "older", boundary),
        entries: [entry("turn-2"), entry("turn-3")],
        entities: [entity("turn-2"), entity("turn-3")],
        continuation: available("older:page-2", "cursor:1"),
      });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.topology.islands[0]!.entries.map((value) => value.value)).toEqual([
        "turn-2",
        "turn-3",
        "turn-4",
        "turn-5",
      ]);
      expect(result.topology.entitiesByKey["turn-4"]).toBe(oldTurn);
      expect(measureCodexHistoryResidency(result.topology).turnCount).toBe(4);
    });

    test("rejects a stale generation and a cursor that does not advance", () => {
      const topology = expectTopology(
        createCodexHistoryIslandTopology({
          generation: 8,
          islandId: "tail:8",
          entries: [entry("turn-2")],
          entities: [entity("turn-2")],
          olderBoundary: available("older:tail", "cursor:1"),
          newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
        }),
      );
      const boundary = topology.islands[0]!.olderBoundary;
      if (boundary.status !== "available") throw new Error("expected available boundary");
      const stale = mergeCodexHistoryBoundaryPage(topology, {
        boundary: createCodexHistoryBoundaryRef(7, "tail:8", "older", boundary),
        entries: [entry("turn-1")],
        entities: [entity("turn-1")],
        continuation: exhaustedCodexHistoryBoundary("older:done"),
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "staleGeneration" } });
      const stalled = mergeCodexHistoryBoundaryPage(topology, {
        boundary: createCodexHistoryBoundaryRef(8, "tail:8", "older", boundary),
        entries: [entry("turn-1")],
        entities: [entity("turn-1")],
        continuation: available("older:still", "cursor:1"),
      });
      expect(stalled).toMatchObject({ ok: false, error: { code: "cursorStalled" } });
    });

    test("accepts an outstanding page after its boundary survives an island merge", () => {
      const boundary = available("retained:older", "cursor:1");
      const topology = expectTopology(
        createCodexHistoryIslandTopology({
          generation: 6,
          islandId: "merged:6",
          entries: [entry("turn-2")],
          entities: [entity("turn-2")],
          olderBoundary: boundary,
          newerBoundary: exhaustedCodexHistoryBoundary("merged:newer"),
        }),
      );
      if (boundary.status !== "available") throw new Error("Expected available boundary");
      const reference = createCodexHistoryBoundaryRef(6, "old:6", "older", boundary);
      const result = mergeCodexHistoryBoundaryPage(topology, {
        boundary: reference,
        entries: [entry("turn-1")],
        entities: [entity("turn-1")],
        continuation: exhaustedCodexHistoryBoundary("page:newer-id"),
      });
      const next = expectTopology(result);
      expect(next.islands[0]?.olderBoundary.boundaryId).toBe("retained:older");
      expect(next.islands[0]?.entries.map((item) => item.value)).toEqual(["turn-1", "turn-2"]);
      expect(next.isComplete).toBe(true);
    });

    test("advances a cursor when its anchor changes and rejects replaying its old progress", () => {
      const boundary = availableCodexHistoryBoundary("tail:older", {
        cursor: "cursor:1",
        oldestLoadedTurnId: "turn-2",
      });
      const topology = expectTopology(
        createCodexHistoryIslandTopology({
          generation: 6,
          islandId: "tail:6",
          entries: [entry("turn-2")],
          entities: [entity("turn-2")],
          olderBoundary: boundary,
          newerBoundary: exhaustedCodexHistoryBoundary("tail:newer"),
        }),
      );
      if (boundary.status !== "available") throw new Error("Expected available boundary");
      const reference = createCodexHistoryBoundaryRef(6, "tail:6", "older", boundary);
      const page = {
        boundary: reference,
        entries: [entry("turn-1")],
        entities: [entity("turn-1")],
        continuation: availableCodexHistoryBoundary("ignored:page-id", {
          cursor: "cursor:1",
          oldestLoadedTurnId: "turn-1",
        }),
      };
      const next = expectTopology(mergeCodexHistoryBoundaryPage(topology, page));
      expect(next.islands[0]?.olderBoundary).toMatchObject({
        boundaryId: "tail:older",
        handle: { cursor: "cursor:1", oldestLoadedTurnId: "turn-1" },
      });
      expect(mergeCodexHistoryBoundaryPage(next, page).ok).toBe(false);
    });

    test("merges an overlapping search island using the caller Turn policy", () => {
      const search = expectTopology(
        createCodexHistoryIslandTopology({
          generation: 3,
          islandId: "search:1",
          entries: [entry("turn-1"), entry("turn-2")],
          entities: [entity("turn-1"), entity("turn-2", { durationMs: 4 })],
          olderBoundary: exhaustedCodexHistoryBoundary("older:search"),
          newerBoundary: available("newer:search"),
        }),
      );
      const merged = insertCodexHistoryIsland(search, {
        index: 1,
        mergeTurns: (current, incoming) => ({ ...incoming, durationMs: current.durationMs }),
        islandId: "tail:3",
        entries: [entry("turn-2"), entry("turn-3")],
        entities: [entity("turn-2", { durationMs: 99 }), entity("turn-3")],
        olderBoundary: available("older:tail"),
        newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
      });
      if (!merged.ok) throw new Error(merged.error.message);
      expect(merged.topology.islands).toHaveLength(1);
      expect(merged.topology.islands[0]!.entries.map((value) => value.value)).toEqual([
        "turn-1",
        "turn-2",
        "turn-3",
      ]);
      expect(merged.topology.entitiesByKey["turn-2"]?.durationMs).toBe(4);
    });

    test("aligns an overlapping search window around its resident anchor positions", () => {
      const tail = expectTopology(
        createCodexHistoryIslandTopology({
          generation: 4,
          islandId: "tail:4",
          entries: [entry("turn-a"), entry("turn-b"), entry("turn-c")],
          entities: [entity("turn-a"), entity("turn-b"), entity("turn-c")],
          olderBoundary: available("older:tail"),
          newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
        }),
      );
      const inserted = insertCodexHistoryIsland(tail, {
        index: 0,
        islandId: "search:4",
        entries: [entry("turn-x"), entry("turn-b"), entry("turn-c"), entry("turn-d")],
        entities: [entity("turn-x"), entity("turn-b"), entity("turn-c"), entity("turn-d")],
        olderBoundary: available("older:search"),
        newerBoundary: available("newer:search"),
        positionsByEntityKey: {
          "turn-a": 0,
          "turn-x": 1,
          "turn-b": 2,
          "turn-c": 3,
          "turn-d": 4,
        },
      });
      if (!inserted.ok) throw new Error(inserted.error.message);
      expect(inserted.topology.islands[0]?.entries.map((value) => value.value)).toEqual([
        "turn-a",
        "turn-x",
        "turn-b",
        "turn-c",
        "turn-d",
      ]);
    });

    test("keeps disjoint search and tail islands separated by one bidirectional gap", () => {
      const search = expectTopology(
        createCodexHistoryIslandTopology({
          generation: 5,
          islandId: "search:5",
          entries: [entry("turn-20")],
          entities: [entity("turn-20")],
          olderBoundary: available("older:search"),
          newerBoundary: available("newer:search"),
        }),
      );
      const inserted = insertCodexHistoryIsland(search, {
        index: 1,
        islandId: "tail:5",
        entries: [entry("turn-100")],
        entities: [entity("turn-100")],
        olderBoundary: available("older:tail"),
        newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
      });
      if (!inserted.ok) throw new Error(inserted.error.message);
      const rows = flattenCodexHistoryTopology(inserted.topology);
      expect(rows.map((row) => row.kind)).toEqual(["gap", "content", "gap", "content"]);
      expect(rows[2]).toMatchObject({
        kind: "gap",
        olderBoundary: { islandId: "search:5", edge: "newer" },
        newerBoundary: { islandId: "tail:5", edge: "older" },
      });
    });

    test("records complete Turn history independently from partially loaded items", () => {
      const partial = expectTopology(
        createCodexHistoryIslandTopology({
          generation: 6,
          islandId: "tail:6",
          entries: [entry("turn-1")],
          entities: [entity("turn-1", { itemsView: "summary" })],
          olderBoundary: exhaustedCodexHistoryBoundary("older:tail"),
          newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
        }),
      );
      expect(partial.isComplete).toBe(true);
      expect(partial.entitiesByKey["turn-1"]?.itemsPagination.hasLoadedOldest).toBe(false);
    });

    test("preserves explicit incomplete history through a resident item update with exhausted boundaries", () => {
      const incomplete = expectTopology(
        createCodexHistoryIslandTopology({
          generation: 7,
          isComplete: false,
          islandId: "tail:7",
          entries: [entry("turn-1")],
          entities: [entity("turn-1")],
          olderBoundary: exhaustedCodexHistoryBoundary("older:tail"),
          newerBoundary: exhaustedCodexHistoryBoundary("newer:tail"),
        }),
      );
      expect(incomplete.isComplete).toBe(false);
      expect(validateCodexHistoryTopology(incomplete)).toBeNull();
      const updated = replaceCodexHistoryEntity(incomplete, {
        expectedGeneration: 7,
        entity: entity("turn-1", { durationMs: 1 }),
      });
      expect(updated.ok && updated.topology.isComplete).toBe(false);
    });
    test("retires a boundary reference when its native source changes at the same cursor", () => {
      const older = availableCodexHistoryBoundary("older", {
        source: "ordinary",
        cursor: "same",
        oldestLoadedTurnId: "turn-1",
      });
      if (older.status !== "available") throw new Error("Expected available boundary");
      const topology = expectTopology(
        createCodexHistoryIslandTopology({
          generation: 1,
          islandId: "tail",
          entries: [entry("turn-1")],
          entities: [entity("turn-1")],
          olderBoundary: older,
          newerBoundary: exhaustedCodexHistoryBoundary("newer"),
        }),
      );
      const reference = createCodexHistoryBoundaryRef(1, "tail", "older", older);
      expect(readCurrentCodexHistoryBoundary(topology, reference)).toBe(older);
      const replaced = {
        ...topology,
        islands: topology.islands.map((island) => ({
          ...island,
          olderBoundary: { ...older, handle: { ...older.handle, source: "compact" as const } },
        })),
      };
      expect(readCurrentCodexHistoryBoundary(replaced, reference)).toBeNull();
    });
  });
});

describe("codex item timeline index", () => {
  enablePatches();
  const entry = (id: string, position: number): CodexCanonicalTimelineEntry => ({
    type: "realtime",
    position,
    item: {
      type: "transcriptSegment",
      id,
      realtimeSessionId: "session",
      role: "assistant",
      text: id,
    },
  });
  const fixture = (size = 3): CodexCanonicalItemTimeline => ({
    activeRealtimeSessionAtPageStart: null,
    entries: Array.from({ length: size }, (_, index) => entry(String(index), index)),
  });

  describe("resident timeline identity index", () => {
    test("retains indexed positions across sparse append and completion mutations", () => {
      const index = new CodexItemTimelineIndex();
      const before = { itemTimeline: fixture() };
      expect(index.position(before.itemTimeline, "realtime:1")).toBe(1);
      const [appended, patches] = produceWithPatches(before, (draft) => {
        draft.itemTimeline.entries.push(entry("new", 3));
      });
      index.update(before.itemTimeline, appended.itemTimeline, patches);
      expect(index.position(appended.itemTimeline, "realtime:new")).toBe(3);
      const [completed, completedPatches] = produceWithPatches(appended, (draft) => {
        const item = draft.itemTimeline.entries[1]!;
        if (item.type === "realtime" && item.item.type === "transcriptSegment")
          item.item.text = "final";
      });
      index.update(appended.itemTimeline, completed.itemTimeline, completedPatches);
      expect(index.position(completed.itemTimeline, "realtime:1")).toBe(1);
      expect(index.position(completed.itemTimeline, "realtime:new")).toBe(3);
    });

    test("history prepend, removal and whole replacement rebuild with their authoritative positions", () => {
      const index = new CodexItemTimelineIndex();
      const before = { itemTimeline: fixture() };
      expect(index.position(before.itemTimeline, "realtime:1")).toBe(1);
      const [prepended, patches] = produceWithPatches(before, (draft) => {
        draft.itemTimeline.entries = [entry("older", 0), ...draft.itemTimeline.entries];
      });
      index.update(before.itemTimeline, prepended.itemTimeline, patches);
      expect(index.position(prepended.itemTimeline, "realtime:1")).toBe(2);
      const [removed, removedPatches] = produceWithPatches(prepended, (draft) => {
        draft.itemTimeline.entries.pop();
      });
      index.update(prepended.itemTimeline, removed.itemTimeline, removedPatches);
      expect(index.position(removed.itemTimeline, "realtime:2")).toBeUndefined();
      const replaced = fixture(1);
      index.update(removed.itemTimeline, replaced);
      expect(index.position(replaced, "realtime:1")).toBeUndefined();
      expect(index.position(undefined, "realtime:1")).toBeUndefined();
    });

    test("a sparse live append does not rescan a 10,000-entry resident timeline", () => {
      const index = new CodexItemTimelineIndex();
      let reads = 0;
      const before = fixture(10_000);
      for (const entry of before.entries) {
        const item = entry.type === "realtime" ? entry.item : undefined;
        if (!item) throw new Error("Invalid pressure fixture");
        Object.defineProperty(entry, "item", {
          get: () => {
            reads++;
            return item;
          },
          enumerable: true,
        });
      }
      expect(index.position(before, "realtime:9999")).toBe(9999);
      reads = 0;
      const appended = { ...before, entries: [...before.entries, entry("new", 10_000)] };
      index.update(before, appended, [
        { op: "add", path: ["itemTimeline", "entries", 10_000], value: appended.entries.at(-1) },
      ]);
      expect(index.position(appended, "realtime:9999")).toBe(9999);
      expect(index.position(appended, "realtime:new")).toBe(10_000);
      expect(reads).toBe(0);
    });
  });
});

describe("codex live item timeline", () => {
  function fixture() {
    return createCodexCanonicalHydratedConversationState(
      {
        ...buildAgentActivityV2CorpusThread([]),
        id: "thread",
        cliVersion: "0.162.0-alpha.17.2",
        turns: [],
      },
      {
        hostId: "local",
        model: "model",
        reasoningEffort: null,
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace"],
      },
    );
  }
  const transcript = (text = "hello"): ThreadRealtimeItem => ({
    type: "transcriptSegment",
    id: "segment",
    realtimeSessionId: "session",
    role: "assistant",
    text,
  });
  function apply(
    state: CodexCanonicalConversationState,
    notification: ServerNotification,
    supportsThreadTimeline = true,
  ) {
    return reduceCodexConversationEvent(
      state,
      { type: "notification", notification },
      { now: () => 1, supportsThreadTimeline },
    );
  }

  describe("live canonical timeline", () => {
    test("streams only an unfinished transcript, completes it in place, and never revives it on duplicate start", () => {
      const initial = fixture();
      let state = apply(initial, {
        method: "thread/realtime/item/started",
        params: { threadId: "thread", item: transcript() },
      });
      expect(state.itemTimeline?.entries[0]).toMatchObject({
        position: 1,
        item: { id: "segment" },
      });
      state = apply(state, {
        method: "thread/realtime/item/transcript/delta",
        params: { threadId: "thread", itemId: "segment", delta: " world" },
      });
      expect(state.realtimeItems?.segment?.item).toMatchObject({ text: "hello world" });
      state = apply(state, {
        method: "thread/realtime/item/completed",
        params: { threadId: "thread", item: transcript("final") },
      });
      expect(state.itemTimeline?.entries).toHaveLength(1);
      expect(state.itemTimeline?.entries[0]).toMatchObject({
        position: 1,
        item: { text: "final" },
      });
      expect(state.realtimeItems?.segment).toMatchObject({
        completed: true,
        item: { text: "final" },
      });
      expect(
        apply(state, {
          method: "thread/realtime/item/transcript/delta",
          params: { threadId: "thread", itemId: "segment", delta: "late" },
        }),
      ).toBe(state);
      expect(
        apply(state, {
          method: "thread/realtime/item/started",
          params: { threadId: "thread", item: transcript("duplicate") },
        }),
      ).toBe(state);
      expect(initial.itemTimeline).toBeUndefined();
    });

    test("admits session and promotion records only on completion, appending after the resident timeline", () => {
      let state = {
        ...fixture(),
        itemTimeline: {
          activeRealtimeSessionAtPageStart: "older-session",
          entries: [{ type: "realtime" as const, position: 41, item: transcript() }],
        },
      };
      const item: ThreadRealtimeItem = {
        type: "bemItemPromoted",
        id: "receipt",
        realtimeSessionId: "session",
        turnId: "missing-turn",
        itemId: "missing-item",
        presentation: { type: "wholeItem" },
      };
      expect(
        apply(state, {
          method: "thread/realtime/item/started",
          params: { threadId: "thread", item },
        }),
      ).toBe(state);
      const completed = apply(state, {
        method: "thread/realtime/item/completed",
        params: { threadId: "thread", item },
      });
      expect(completed.itemTimeline?.entries.at(-1)).toEqual({
        type: "realtime",
        position: 42,
        item,
      });
      expect(completed.turns).toEqual([]);
      expect(completed.itemTimeline?.activeRealtimeSessionAtPageStart).toBe("older-session");
      expect(completed.realtimeItems?.receipt).toEqual({ item, completed: true });
    });

    test("preserves ordinary item identity across completion and distinguishes the same item id in another Turn", () => {
      const turn = buildAgentActivityV2CorpusThread().turns[0]!;
      let state = apply(fixture(), {
        method: "turn/started",
        params: { threadId: "thread", turn },
      });
      const item = { type: "plan" as const, id: "shared-id", text: "plan" };
      state = apply(state, {
        method: "item/started",
        params: { threadId: "thread", turnId: turn.id, item, startedAtMs: 1 },
      });
      state = apply(state, {
        method: "item/completed",
        params: { threadId: "thread", turnId: turn.id, item, completedAtMs: 2 },
      });
      state = apply(state, {
        method: "item/completed",
        params: { threadId: "thread", turnId: "other", item, completedAtMs: 3 },
      });
      expect(state.itemTimeline?.entries.map((entry) => entry.position)).toEqual([1, 2, 3]);
      expect(state.itemTimeline?.entries[1]).toMatchObject({
        type: "item",
        turnId: turn.id,
        item: { completed: true },
      });
      expect(state.itemTimeline?.entries[2]).toMatchObject({ type: "item", turnId: "other" });
    });

    test.each(["capability", "voice-history", "legacy-history", "wrong-thread"])(
      "does not mutate outside the %s boundary",
      (boundary) => {
        const initial = {
          ...fixture(),
          ...(boundary === "voice-history" ? { canonicalVoiceHistory: false } : {}),
          ...(boundary === "legacy-history" ? { historyMode: "legacy" as const } : {}),
        };
        const after = apply(
          initial,
          {
            method: "thread/realtime/item/completed",
            params: {
              threadId: boundary === "wrong-thread" ? "foreign" : "thread",
              item: transcript(),
            },
          },
          boundary !== "capability",
        );
        expect(after).toBe(initial);
      },
    );

    test("retains the raw itemAdded contract without interpreting it as a canonical receipt", () => {
      const initial = fixture();
      expect(
        apply(initial, {
          method: "thread/realtime/itemAdded",
          params: { threadId: "thread", item: { type: "bemItemPromoted", id: "raw" } },
        }),
      ).toBe(initial);
    });
  });
});
