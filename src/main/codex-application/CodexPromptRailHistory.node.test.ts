import { assert, it } from "@effect/vitest";
import type { Thread, ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { CodexConversationHistoryMutation } from "../../shared/codex-conversation-history-page";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { createEmptyCodexHistoryTopology } from "../../shared/codex-conversation-state/codex-history-topology";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  CodexHistoryPageAdapter,
  type CodexHydratedHistoryTurnPage,
} from "./CodexHistoryPageAdapter";
import {
  make,
  type CodexPromptRailHistoryError,
  type CodexPromptRailHistoryUnavailable,
} from "./CodexPromptRailHistory";
import { CodexThreadHistoryFeatures } from "./CodexThreadHistoryFeatures";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import type { ConversationEntityState } from "./internal/ConversationEntityState";

const turnShell = (id: string): Turn => ({
  id,
  status: "completed",
  items: [],
  itemsView: "notLoaded",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});

const snapshot: CodexAppServerCapabilitySnapshot = {
  hostId: "host-a",
  generation: 7,
  userAgent: "Codex Desktop/0.149.0",
  version: "0.149.0",
  flags: {
    forkLastTurnId: true,
    paginatedHistory: true,
    searchOccurrences: true,
    ephemeralFork: true,
    multiAgentV2Protocol: false,
    sideConversation: true,
    subagentAncestorFilter: false,
    threadRevert: true,
  },
};

const capabilities = CodexAppServerCapabilities.of({
  forThread: () => Effect.succeed(snapshot),
  forHost: () => Effect.succeed(snapshot),
  isCurrent: (candidate) =>
    Effect.succeed(
      candidate.hostId === snapshot.hostId && candidate.generation === snapshot.generation,
    ),
});

const mutation = {
  origin: {
    kind: "island",
    threadId: "thread-a",
    mutationId: "reveal-1",
    expectedConversationGeneration: 3,
    expectedTopologyGeneration: 11,
  },
  threadId: "thread-a",
  conversationGeneration: 3,
  topologyGeneration: 12,
  baseHistoryMutationRevision: 4,
  historyMutationRevision: 5,
  upsertTurns: [],
  upsertCanonicalTurns: [],
  removeTurnIds: [],
  turnItems: [],
  rowSplices: [],
  turnPagination: {
    olderCursor: null,
    backwardsCursor: null,
    oldestLoadedTurnId: null,
    isLoadingOlder: false,
    hasLoadedOldest: false,
    loadedTurnCount: 0,
    itemsView: "notLoaded",
  },
  turnItemsPaginationUpserts: {},
  removeTurnItemsPaginationIds: [],
} satisfies CodexConversationHistoryMutation;

const currentCanonical = createCodexCanonicalHydratedConversationState(
  { id: "thread-a", historyMode: "paginated", turns: [] } as unknown as Thread,
  {
    model: "gpt-test",
    reasoningEffort: "high",
    cwd: "/workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: ["/workspace"],
  },
);

const conversationMap = (onInsert?: (input: unknown) => void): ConversationEntityMap["Service"] => {
  const entity = {
    generation: 3,
    readSnapshot: () => ({}),
    readCanonicalState: () => currentCanonical,
    readHistoryTopology: () => createEmptyCodexHistoryTopology(11),
    insertHistoryIsland: (input: unknown) => {
      onInsert?.(input);
      return { status: "committed", topologyGeneration: 12, mutation } as const;
    },
  } as unknown as ConversationEntityState;
  return ConversationEntityMap.of({
    entity: () => entity,
    current: () => entity,
    runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) => operation,
    markAllNeedsResume: () => [],
    retire: () => Effect.void,
  });
};

const unusedHistoryPages = CodexHistoryPageAdapter.of({
  loadTurnPage: () => Effect.die("Unexpected prompt rail reveal"),
  loadTurnItemsPage: () => Effect.die("Unexpected prompt rail item page"),
});

const historyFeatures = CodexThreadHistoryFeatures.of({
  resolve: (threadId, feature) =>
    Effect.succeed({
      status: "available",
      feature,
      threadId,
      historyMode: "paginated",
      capability: snapshot,
    }),
});

const provide = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | CodexAppServerCapabilities
    | CodexGateway
    | CodexHistoryPageAdapter
    | ConversationEntityMap
    | CodexThreadHistoryFeatures
  >,
  gateway: CodexGateway["Service"],
  pages: CodexHistoryPageAdapter["Service"] = unusedHistoryPages,
  conversations: ConversationEntityMap["Service"] = conversationMap(),
) =>
  effect.pipe(
    Effect.provideService(CodexGateway, gateway),
    Effect.provideService(CodexAppServerCapabilities, capabilities),
    Effect.provideService(CodexHistoryPageAdapter, pages),
    Effect.provideService(CodexThreadHistoryFeatures, historyFeatures),
    Effect.provideService(ConversationEntityMap, conversations),
  );

const failureReason = (
  failure: CodexPromptRailHistoryError | CodexPromptRailHistoryUnavailable,
): CodexPromptRailHistoryError["reason"] => {
  assert.strictEqual(failure._tag, "CodexPromptRailHistoryError");
  if (failure._tag !== "CodexPromptRailHistoryError") {
    throw new Error("Expected an operational prompt rail failure");
  }
  return failure.reason;
};

it.effect("builds and caches a bounded chronological shell index without Turn items", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly params: unknown; readonly scheduling: unknown }> = [];
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown, scheduling: unknown) =>
        Effect.sync(() => {
          assert.strictEqual(method, "thread/turns/list");
          requests.push({ params, scheduling });
          const cursor = (params as { readonly cursor: string | null }).cursor;
          return cursor === null
            ? {
                data: [turnShell("turn-4"), turnShell("turn-3")],
                nextCursor: "page:older",
                backwardsCursor: "page:newer-1",
              }
            : {
                data: [turnShell("turn-2"), turnShell("turn-1")],
                nextCursor: "page:still-older",
                backwardsCursor: "page:newer-2",
              };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    let nowMs = 1_000;
    const service = yield* provide(make({ maxPages: 2, pageSize: 2, now: () => nowMs }), gateway);

    const first = yield* service.loadIndex("thread-a", { expectedTopologyGeneration: 11 });
    assert.deepStrictEqual(
      first.shells.map((shell) => [
        shell.turnId,
        shell.pageBackwardsCursor,
        shell.descendingOffset,
      ]),
      [
        ["turn-1", "page:newer-2", 1],
        ["turn-2", "page:newer-2", 0],
        ["turn-3", "page:newer-1", 1],
        ["turn-4", "page:newer-1", 0],
      ],
    );
    assert.isFalse(first.complete);
    assert.strictEqual(first.truncatedBy, "page-budget");
    assert.isAtMost(first.shells.length, 4);
    assert.isAbove(first.approximateBytes, 0);
    assert.deepStrictEqual(
      requests.map(({ scheduling }) => scheduling),
      Array(2).fill({
        priority: "background",
        source: "tail_history",
        expectedHostId: "host-a",
        expectedGeneration: 7,
      }),
    );

    nowMs += 29_999;
    assert.strictEqual(
      yield* service.loadIndex("thread-a", { expectedTopologyGeneration: 11 }),
      first,
    );
    assert.strictEqual(requests.length, 2);
  }),
);

it.effect("rejects a shell page that exceeds its exact physical request limit", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: () =>
        Effect.succeed({
          data: [turnShell("turn-2"), turnShell("turn-1")],
          nextCursor: null,
          backwardsCursor: null,
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const service = yield* provide(make({ maxPages: 1, pageSize: 1 }), gateway);

    const failure = yield* service
      .loadIndex("thread-a", { expectedTopologyGeneration: 11 })
      .pipe(Effect.flip);

    assert.strictEqual(failureReason(failure), "page-size-exceeded");
  }),
);

it.effect("rejects a forged shell offset before issuing a host request", () =>
  Effect.gen(function* () {
    let hostRequests = 0;
    const gateway = CodexGateway.of({
      requestForThread: () =>
        Effect.sync(() => {
          hostRequests += 1;
          return { data: [], nextCursor: null, backwardsCursor: null } as never;
        }),
    } as unknown as CodexGateway["Service"]);
    const service = yield* provide(make(), gateway);

    const failure = yield* service
      .reveal({
        requestId: "forged-offset",
        threadId: "thread-a",
        hostId: "host-a",
        generation: 7,
        expectedTopologyGeneration: 11,
        shell: {
          turnId: "selected-turn",
          pageBackwardsCursor: "cursor:selected",
          descendingOffset: 100,
        },
      })
      .pipe(Effect.flip);

    assert.strictEqual(failureReason(failure), "invalid-reveal");
    assert.strictEqual(hostRequests, 0);
  }),
);

it.effect("resolves one shell offset and hydrates only the selected Turn", () =>
  Effect.gen(function* () {
    const skipRequests: unknown[] = [];
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown, scheduling: unknown) =>
        Effect.sync(() => {
          assert.strictEqual(method, "thread/turns/list");
          skipRequests.push({ params, scheduling });
          return {
            data: [turnShell("newer-turn")],
            nextCursor: "cursor:selected",
            backwardsCursor: "cursor:newest",
          };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const prompt: ThreadItem = {
      type: "userMessage",
      id: "prompt",
      clientId: null,
      content: [{ type: "text", text: "question 😀", text_elements: [] }],
    };
    const response: ThreadItem = {
      questions: null,
      type: "agentMessage",
      id: "response",
      text: "answer",
      phase: null,
      memoryCitation: null,
      delivery: null,
    };
    const selectedTurn = {
      ...turnShell("selected-turn"),
      items: [prompt, response],
      itemsView: "full",
      startedAt: 50,
    } satisfies Turn;
    const pageInputs: unknown[] = [];
    const pages = CodexHistoryPageAdapter.of({
      loadTurnPage: (input) => {
        pageInputs.push(input);
        return Effect.succeed({
          turns: [selectedTurn],
          nextCursor: "cursor:older",
          backwardsCursor: "cursor:selected-boundary",
          itemsPaginationByTurnId: {
            "selected-turn": {
              olderCursor: null,
              isLoadingOlder: false,
              hasLoadedOldest: true,
              oldestUserInput: null,
              openingUserMessageId: null,
              itemsView: "full",
            },
          },
          itemSegmentsByTurnId: {
            "selected-turn": [
              {
                itemIds: ["prompt", "response"],
                approximateBytes: 128,
                olderCursor: null,
                newerCursor: null,
              },
            ],
          },
          loadedItemCount: 2,
        } satisfies CodexHydratedHistoryTurnPage);
      },
      loadTurnItemsPage: () => Effect.die("Unexpected item page"),
    });
    let inserted: Record<string, unknown> | null = null;
    const service = yield* provide(
      make({ now: () => 1_234 }),
      gateway,
      pages,
      conversationMap((input) => {
        inserted = input as Record<string, unknown>;
      }),
    );

    const reveal = yield* service.reveal({
      requestId: "reveal-1",
      threadId: "thread-a",
      hostId: "host-a",
      generation: 7,
      expectedTopologyGeneration: 11,
      shell: {
        turnId: "selected-turn",
        pageBackwardsCursor: "cursor:page-start",
        descendingOffset: 1,
      },
    });

    assert.strictEqual(skipRequests.length, 1);
    assert.deepStrictEqual(pageInputs, [
      {
        capability: snapshot,
        threadId: "thread-a",
        cursor: "cursor:selected",
        initialItemsCursor: null,
        limit: 1,
        sortDirection: "desc",
        itemBudget: 100,
        purpose: "older",
      },
    ]);
    assert.strictEqual(reveal.turnId, "selected-turn");
    assert.strictEqual(reveal.topologyGeneration, 12);
    assert.strictEqual(reveal.mutation, mutation);
    assert.notProperty(reveal, "turn");
    assert.deepStrictEqual(reveal.previews, [
      {
        itemId: "prompt",
        promptPreview: "question 😀",
        responsePreview: "answer",
        isHeartbeat: false,
      },
    ]);
    assert.deepInclude(inserted!, {
      mutationId: "reveal-1",
      expectedTopologyGeneration: 11,
      index: 0,
      islandId: "prompt-rail:7:reveal-1",
      turnIds: ["selected-turn"],
      olderBoundary: {
        status: "available",
        boundaryId: "prompt-rail:7:reveal-1:older",
        handle: { cursor: "cursor:older", oldestLoadedTurnId: "selected-turn" },
        progressKey: '["cursor:older","selected-turn"]',
      },
      newerBoundary: {
        status: "available",
        boundaryId: "prompt-rail:7:reveal-1:newer",
        handle: { cursor: "cursor:selected-boundary", oldestLoadedTurnId: "selected-turn" },
        progressKey: '["cursor:selected-boundary","selected-turn"]',
      },
      observedAtMs: 1_234,
      projectReplica: false,
    });
  }),
);

it.effect("rejects a reveal whose topology changes during physical hydration", () =>
  Effect.gen(function* () {
    let topologyGeneration = 11;
    let inserted = false;
    const entity = {
      generation: 3,
      readSnapshot: () => ({}),
      readCanonicalState: () => currentCanonical,
      readHistoryTopology: () => createEmptyCodexHistoryTopology(topologyGeneration),
      insertHistoryIsland: () => {
        inserted = true;
        return { status: "committed", topologyGeneration: 13, mutation } as const;
      },
    } as unknown as ConversationEntityState;
    const conversations = ConversationEntityMap.of({
      entity: () => entity,
      current: () => entity,
      runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) => operation,
      markAllNeedsResume: () => [],
      retire: () => Effect.void,
    });
    const pages = CodexHistoryPageAdapter.of({
      loadTurnPage: () => {
        topologyGeneration = 12;
        return Effect.succeed({
          turns: [{ ...turnShell("selected-turn"), startedAt: 50 }],
          nextCursor: null,
          backwardsCursor: null,
          itemsPaginationByTurnId: {
            "selected-turn": {
              olderCursor: null,
              isLoadingOlder: false,
              hasLoadedOldest: true,
              oldestUserInput: null,
              openingUserMessageId: null,
              itemsView: "full",
            },
          },
          itemSegmentsByTurnId: { "selected-turn": [] },
          loadedItemCount: 0,
        } satisfies CodexHydratedHistoryTurnPage);
      },
      loadTurnItemsPage: () => Effect.die("Unexpected item page"),
    });
    const service = yield* provide(
      make(),
      {
        requestForThread: () => Effect.die("Unexpected shell skip"),
      } as unknown as CodexGateway["Service"],
      pages,
      conversations,
    );

    const failure = yield* service
      .reveal({
        requestId: "reveal-stale",
        threadId: "thread-a",
        hostId: "host-a",
        generation: 7,
        expectedTopologyGeneration: 11,
        shell: {
          turnId: "selected-turn",
          pageBackwardsCursor: "cursor:selected",
          descendingOffset: 0,
        },
      })
      .pipe(Effect.flip);

    assert.strictEqual(failureReason(failure), "stale-topology");
    assert.isFalse(inserted);
  }),
);

it.effect("seeks an explicitly known Turn beyond the shell-index cap with one-page memory", () =>
  Effect.gen(function* () {
    const cursors: Array<string | null> = [];
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) =>
        Effect.sync(() => {
          assert.strictEqual(method, "thread/turns/list");
          const cursor = (params as { readonly cursor: string | null }).cursor;
          cursors.push(cursor);
          return cursor === null
            ? {
                data: [turnShell("turn-new-2"), turnShell("turn-new-1")],
                nextCursor: "cursor:older",
                backwardsCursor: "cursor:newest",
              }
            : {
                data: [turnShell("known-turn"), turnShell("turn-old")],
                nextCursor: "cursor:oldest",
                backwardsCursor: "cursor:known-page",
              };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const knownTurn = {
      ...turnShell("known-turn"),
      items: [],
      itemsView: "full",
      startedAt: 25,
    } satisfies Turn;
    const pages = CodexHistoryPageAdapter.of({
      loadTurnPage: () =>
        Effect.succeed({
          turns: [knownTurn],
          nextCursor: "cursor:older-than-known",
          backwardsCursor: "cursor:known-boundary",
          itemsPaginationByTurnId: {
            "known-turn": {
              olderCursor: null,
              isLoadingOlder: false,
              hasLoadedOldest: true,
              oldestUserInput: null,
              openingUserMessageId: null,
              itemsView: "full",
            },
          },
          itemSegmentsByTurnId: { "known-turn": [] },
          loadedItemCount: 0,
        } satisfies CodexHydratedHistoryTurnPage),
      loadTurnItemsPage: () => Effect.die("Unexpected item page"),
    });
    const service = yield* provide(make({ pageSize: 2 }), gateway, pages);

    const reveal = yield* service.revealKnownTurn({
      requestId: "reveal-1",
      threadId: "thread-a",
      hostId: "host-a",
      generation: 7,
      expectedTopologyGeneration: 11,
      turnId: "known-turn",
    });

    assert.deepStrictEqual(cursors, [null, "cursor:older"]);
    assert.strictEqual(reveal.turnId, "known-turn");
  }),
);

it.effect("stops a fast known-Turn identity seek at its physical page budget", () =>
  Effect.gen(function* () {
    const cursors: Array<string | null> = [];
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) =>
        Effect.sync(() => {
          assert.strictEqual(method, "thread/turns/list");
          const cursor = (params as { readonly cursor: string | null }).cursor;
          cursors.push(cursor);
          return {
            data: [turnShell(`turn-${cursors.length}`)],
            nextCursor: `cursor:${cursors.length}`,
            backwardsCursor: `cursor:newer:${cursors.length}`,
          };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const service = yield* provide(make({ maxPages: 2, pageSize: 1 }), gateway);

    const failure = yield* service
      .revealKnownTurn({
        requestId: "known-budget",
        threadId: "thread-a",
        hostId: "host-a",
        generation: 7,
        expectedTopologyGeneration: 11,
        turnId: "turn-after-cap",
      })
      .pipe(Effect.flip);

    assert.strictEqual(failureReason(failure), "seek-budget-exhausted");
    assert.deepStrictEqual(cursors, [null, "cursor:1"]);
  }),
);

it.effect("interrupts a shell-index read at the bounded background deadline", () =>
  Effect.gen(function* () {
    let released = false;
    const gateway = CodexGateway.of({
      requestForThread: () =>
        Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            }),
          ),
        ) as never,
    } as unknown as CodexGateway["Service"]);
    const service = yield* provide(make({ loadDeadlineMs: 25 }), gateway);
    const load = yield* Effect.forkChild(
      service.loadIndex("thread-a", { expectedTopologyGeneration: 11 }).pipe(Effect.flip),
    );

    yield* Effect.yieldNow;
    yield* TestClock.adjust(25);
    const failure = yield* Fiber.join(load);

    assert.strictEqual(failureReason(failure), "deadline-exceeded");
    assert.isTrue(released);
  }),
);

it.effect("interrupts an identity seek at the same bounded rail deadline", () =>
  Effect.gen(function* () {
    let released = false;
    const gateway = CodexGateway.of({
      requestForThread: () =>
        Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            }),
          ),
        ) as never,
    } as unknown as CodexGateway["Service"]);
    const service = yield* provide(make({ loadDeadlineMs: 25 }), gateway);
    const locate = yield* Effect.forkChild(
      service
        .revealKnownTurn({
          requestId: "known-deadline",
          threadId: "thread-a",
          hostId: "host-a",
          generation: 7,
          expectedTopologyGeneration: 11,
          turnId: "turn-after-1000",
        })
        .pipe(Effect.flip),
    );

    yield* Effect.yieldNow;
    yield* TestClock.adjust(25);
    const failure = yield* Fiber.join(locate);

    assert.strictEqual(failureReason(failure), "deadline-exceeded");
    assert.isTrue(released);
  }),
);
