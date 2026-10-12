import { describe, expect, test, vi } from "vite-plus/test";
import { produce, type Draft } from "immer";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
  type CodexCanonicalItem,
} from "./codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import {
  CODEX_ACTIVE_HISTORY_PROTECTED_ITEM_TYPES,
  evictCodexActiveHistory,
  isCodexActiveHistoryItemEvictable,
  planCodexActiveHistoryEviction,
  type CodexActiveHistoryEvictionOptions,
} from "./codex-active-history-eviction";

function fixture(counts: readonly number[] = [1500]): CodexCanonicalConversationState {
  const thread = buildAgentActivityV2CorpusThread([]);
  const state = createCodexCanonicalHydratedConversationState(
    {
      ...thread,
      id: "thread",
      path: "/synthetic/thread.jsonl",
      turns: counts.map((count, turnIndex) => ({
        id: `turn-${turnIndex}`,
        rootTurnId: null,
        items: Array.from({ length: count }, (_, index) => ({
          type: "reasoning" as const,
          id: `item-${turnIndex}-${index}`,
          summary: [],
          content: [],
        })),
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      })),
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
  const entries = state.turns.map((_, index) => ({
    key: `entity-${index}`,
    value: `entity-${index}`,
  }));
  return {
    ...state,
    turns: [],
    resumeState: "resumed",
    turnHistory: {
      kind: "canonical",
      history: {
        generation: 1,
        isComplete: true,
        islands: [
          {
            id: "island",
            entries,
            olderBoundary: { status: "exhausted", boundaryId: "older" },
            newerBoundary: { status: "exhausted", boundaryId: "newer" },
          },
        ],
        entitiesByKey: Object.fromEntries(
          state.turns.map((turn, index) => [
            `entity-${index}`,
            {
              ...turn,
              completedItemIds: Object.fromEntries(turn.items.map((item) => [item.id, true])),
            },
          ]),
        ),
      },
    },
  };
}
function options(
  overrides: Partial<CodexActiveHistoryEvictionOptions> = {},
): CodexActiveHistoryEvictionOptions {
  return {
    viewports: [{ oldestRenderedTurnId: "turn-0", firstProtectedItemId: "item-0-1000" }],
    supportsThreadItemAnchors: true,
    supportsPaginatedThreadHistory: true,
    isFollower: false,
    hasFollowersOrPendingReconnect: false,
    readEnabled: () => true,
    ...overrides,
  };
}
function turn(state: CodexCanonicalConversationState, entityKey = "entity-0") {
  return state.turnHistory!.history.entitiesByKey[entityKey]!;
}

describe("viewport protected active-history eviction", () => {
  test("1000 items do not trigger; 1001 trims a safe prefix towards 500", () => {
    expect(
      planCodexActiveHistoryEviction(
        fixture([1000]),
        options({
          viewports: [{ oldestRenderedTurnId: "turn-0", firstProtectedItemId: "item-0-999" }],
        }),
      ),
    ).toBeNull();
    expect(
      planCodexActiveHistoryEviction(
        fixture([1001]),
        options({
          viewports: [{ oldestRenderedTurnId: "turn-0", firstProtectedItemId: "item-0-501" }],
        }),
      ),
    ).toEqual([{ entityKey: "entity-0", count: 501 }]);
  });

  test("1500 live items retain the final 500 and release completion evidence of removed items", () => {
    const before = produce(fixture(), (draft) => {
      draft.turnHistory!.history.entitiesByKey["entity-0"]!.status = "inProgress";
    });
    const after = evictCodexActiveHistory(before, options());
    expect(turn(after).items).toHaveLength(500);
    expect(turn(after).items[0]!.id).toBe("item-0-1000");
    expect(turn(after).completedItemIds?.["item-0-999"]).toBeUndefined();
    expect(turn(after).completedItemIds?.["item-0-1000"]).toBe(true);
    expect(turn(after).itemsPagination).toMatchObject({
      olderCursor: null,
      olderItemId: "item-0-1000",
      evicted: true,
      hasLoadedOldest: false,
    });
    expect(turn(before).items).toHaveLength(1500);
  });

  test("a fully emptied older Turn has no invented anchor; the protected Turn remains identical", () => {
    const before = fixture([600, 501]);
    const after = evictCodexActiveHistory(
      before,
      options({ viewports: [{ oldestRenderedTurnId: "turn-1", firstProtectedItemId: null }] }),
    );
    expect(turn(after).items).toEqual([]);
    expect(turn(after).itemsPagination).toMatchObject({
      olderCursor: null,
      evicted: true,
      hasLoadedOldest: false,
    });
    expect((turn(after).itemsPagination as { olderItemId?: string }).olderItemId).toBeUndefined();
    expect(turn(after, "entity-1")).toBe(turn(before, "entity-1"));
  });

  test("all viewers protect their earliest common item and null/unknown IDs stop eviction", () => {
    const before = fixture();
    expect(
      planCodexActiveHistoryEviction(
        before,
        options({
          viewports: [
            { oldestRenderedTurnId: "turn-0", firstProtectedItemId: "item-0-900" },
            { oldestRenderedTurnId: "turn-0", firstProtectedItemId: "item-0-400" },
          ],
        }),
      ),
    ).toEqual([{ entityKey: "entity-0", count: 400 }]);
    for (const viewports of [
      [],
      [null],
      [{ oldestRenderedTurnId: "turn-0", firstProtectedItemId: null }],
      [{ oldestRenderedTurnId: "turn-0", firstProtectedItemId: "unknown" }],
      [{ oldestRenderedTurnId: "unknown", firstProtectedItemId: "item" }],
    ])
      expect(planCodexActiveHistoryEviction(before, options({ viewports }))).toBeNull();
  });

  test.each([...CODEX_ACTIVE_HISTORY_PROTECTED_ITEM_TYPES, "autoReviewInterruptionWarning"])(
    "%s stops the prefix and preserves preceding context",
    (type) => {
      const before = produce(fixture(), (draft) => {
        draft.turnHistory!.history.entitiesByKey["entity-0"]!.items[100] = {
          type,
          id: "unsafe",
        } as Draft<CodexCanonicalItem>;
      });
      expect(planCodexActiveHistoryEviction(before, options())).toEqual([
        { entityKey: "entity-0", count: 99 },
      ]);
      const after = evictCodexActiveHistory(before, options());
      expect(turn(after).items[0]!.id).toBe("item-0-99");
      expect(turn(after).items[1]!.id).toBe("unsafe");
    },
  );

  test("running Turns require explicit completion, while completed Turns do not invent this requirement", () => {
    const before = fixture();
    const withoutEvidence = produce(before, (draft) => {
      delete draft.turnHistory!.history.entitiesByKey["entity-0"]!.completedItemIds;
    });
    expect(planCodexActiveHistoryEviction(withoutEvidence, options())).toEqual([
      { entityKey: "entity-0", count: 1000 },
    ]);
    const running = produce(withoutEvidence, (draft) => {
      draft.turnHistory!.history.entitiesByKey["entity-0"]!.status = "inProgress";
    });
    expect(planCodexActiveHistoryEviction(running, options())).toBeNull();
    const falseEvidence = produce(before, (draft) => {
      const value = draft.turnHistory!.history.entitiesByKey["entity-0"]!;
      value.status = "inProgress";
      value.completedItemIds!["item-0-20"] = false;
    });
    expect(planCodexActiveHistoryEviction(falseEvidence, options())).toEqual([
      { entityKey: "entity-0", count: 19 },
    ]);
  });

  test("in-progress/status and explicitly incomplete items are unsafe in every Turn", () => {
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

  test("loading, requests, summaries, reconnect, ephemeral and ambiguous topology all prevent eviction", () => {
    const base = fixture();
    const cases = [
      { ...base, rolloutPath: "" },
      { ...base, ephemeral: true },
      { ...base, resumeState: "resuming" as const },
      { ...base, turns: [turn(base)] },
      { ...base, itemTimeline: {} },
      {
        ...base,
        turnsPagination: {
          source: "timeline",
          olderCursor: null,
          oldestLoadedTurnId: null,
          isLoadingOlder: false,
          hasLoadedOldest: true,
        },
      },
      {
        ...base,
        turnsPagination: {
          olderCursor: null,
          oldestLoadedTurnId: null,
          isLoadingOlder: true,
          hasLoadedOldest: true,
        },
      },
      produce(base, (draft) => {
        draft.turnHistory!.history.islands.push({
          ...draft.turnHistory!.history.islands[0]!,
          id: "other",
        });
      }),
    ];
    for (const state of cases)
      expect(
        planCodexActiveHistoryEviction(state as CodexCanonicalConversationState, options()),
      ).toBeNull();
    for (const extra of [
      { isLoadingOlder: true },
      { summaryItemIds: [] },
      { reconnect: { beforeItemId: null, stopItemId: null } },
    ]) {
      const state = produce(base, (draft) => {
        const value = draft.turnHistory!.history.entitiesByKey["entity-0"]!;
        value.itemsPagination = {
          itemsView: "full",
          olderCursor: null,
          isLoadingOlder: false,
          hasLoadedOldest: true,
          ...extra,
        };
      });
      expect(planCodexActiveHistoryEviction(state, options())).toBeNull();
    }
    const requestState = {
      ...base,
      requests: [
        {
          id: "request",
          method: "item/plan/requestImplementation",
          params: { threadId: "thread", turnId: "turn-0", planContent: "plan" },
        },
      ],
    } satisfies CodexCanonicalConversationState;
    expect(planCodexActiveHistoryEviction(requestState, options())).toBeNull();
  });

  test("capabilities, stream followers and unknown/false gate each refuse the candidate", () => {
    const state = fixture();
    for (const override of [
      { supportsThreadItemAnchors: false },
      { supportsPaginatedThreadHistory: false },
      { isFollower: true },
      { hasFollowersOrPendingReconnect: true },
      { readEnabled: () => false },
      { readEnabled: () => undefined },
      { readEnabled: () => null },
    ])
      expect(planCodexActiveHistoryEviction(state, options(override))).toBeNull();
    const read = vi.fn(() => true);
    expect(
      planCodexActiveHistoryEviction(fixture([10]), options({ readEnabled: read })),
    ).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(planCodexActiveHistoryEviction(state, options({ readEnabled: read }))).not.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
