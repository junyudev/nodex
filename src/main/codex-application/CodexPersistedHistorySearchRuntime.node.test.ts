import { assert, it } from "@effect/vitest";
import type { Thread, ThreadSearchOccurrence, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import type { CodexConversationSnapshot } from "../../shared/types";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalTurnState,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryIslandTopology,
  exhaustedCodexHistoryBoundary,
  insertCodexHistoryIsland,
  opaqueCodexHistoryBoundary,
  type CodexHistoryEntity,
  type CodexHistoryTurnItemsPagination,
} from "../../shared/codex-conversation-state/codex-history-topology";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexConversationHistoryRuntime } from "./CodexConversationHistoryRuntime";
import {
  CodexHistorySearchAdapter,
  CodexHistorySearchAdapterError,
} from "./CodexHistorySearchAdapter";
import { CodexThreadHistoryFeatures } from "./CodexThreadHistoryFeatures";
import {
  CodexPersistedHistorySearchRuntime,
  make as makePersistedHistorySearchRuntime,
  makePersistedHistoryHydrationRequestTracker,
  placeCodexHistorySearchIsland,
} from "./CodexPersistedHistorySearchRuntime";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";

const rawTurn = (id: string, startedAt: number | null): Turn => ({
  id,
  items: [],
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt,
  completedAt: startedAt,
  durationMs: 0,
});

it("bounds the hydration navigation index without letting stale completion cancel a replacement", () => {
  const tracker = makePersistedHistoryHydrationRequestTracker(2);
  tracker.begin("thread-a", "request-a1");
  tracker.begin("thread-b", "request-b1");
  tracker.begin("thread-a", "request-a2");
  tracker.complete("thread-a", "request-a1");

  assert.isTrue(tracker.isLatest("thread-a", "request-a2"));
  assert.isTrue(tracker.isLatest("thread-b", "request-b1"));
  assert.strictEqual(tracker.size(), 2);

  tracker.begin("thread-c", "request-c1");
  assert.isFalse(tracker.isLatest("thread-b", "request-b1"));
  assert.isTrue(tracker.isLatest("thread-a", "request-a2"));
  assert.isTrue(tracker.isLatest("thread-c", "request-c1"));
  assert.strictEqual(tracker.size(), 2);

  tracker.complete("thread-a", "request-a2");
  tracker.complete("thread-c", "request-c1");
  assert.strictEqual(tracker.size(), 0);
});

const canonicalTurns = (turns: readonly Turn[]): readonly CodexCanonicalTurnState[] => {
  const thread: Thread = {
    model: null,
    reasoningEffort: null,
    id: "thread-search-placement",
    extra: null,
    sessionId: "session-search-placement",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    cliVersion: "test",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [...turns],
  };
  return createCodexCanonicalHydratedConversationState(thread, {
    model: "gpt-test",
    reasoningEffort: "high",
    cwd: "/workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: ["/workspace"],
  }).turns;
};

const entity = (turn: CodexCanonicalTurnState): CodexHistoryEntity<CodexCanonicalTurnState> => ({
  key: turn.protocol.id!,
  turn,
  itemCount: turn.items.length,
  approximateBytes: 1,
  itemsPagination: {
    olderCursor: null,
    isLoadingOlder: false,
    hasLoadedOldest: true,
    oldestUserInput: null,
    openingUserMessageId: null,
    itemsView: "full",
  },
  authority: "history",
  revision: 1,
});

const runtimeThreadId = "thread-search-runtime";
const selectedOccurrence: ThreadSearchOccurrence = {
  turnId: "turn-search",
  itemId: "item-selected",
  snippet: "needle",
  snippetMatchRange: { start: 0, end: 6 },
  turnCursor: "cursor-turn-search",
};

const runtimeThread = (turns: readonly Turn[]): Thread => ({
  model: null,
  reasoningEffort: null,
  id: runtimeThreadId,
  extra: null,
  sessionId: "session-search-runtime",
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 1,
  recencyAt: 1,
  status: { type: "idle" },
  path: null,
  cwd: "/workspace",
  cliVersion: "test",
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [...turns],
});

const runtimeHydration = {
  model: "gpt-test",
  reasoningEffort: "high" as const,
  cwd: "/workspace",
  approvalPolicy: "on-request" as const,
  approvalsReviewer: "user" as const,
  sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
  activePermissionProfile: null,
  runtimeWorkspaceRoots: ["/workspace"],
};

const fullItemsPagination = {
  olderCursor: null,
  isLoadingOlder: false,
  hasLoadedOldest: true,
  oldestUserInput: null,
  openingUserMessageId: null,
  itemsView: "full" as const,
};

const installRuntimeConversation = (input: {
  readonly turns: readonly Turn[];
  readonly itemsPaginationByTurnId?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
}) => {
  const state = createCodexCanonicalHydratedConversationState(
    runtimeThread(input.turns),
    runtimeHydration,
  );
  const registry = makeConversationEntityStateRegistry();
  const aggregate = registry.acquire(runtimeThreadId);
  aggregate.acceptCanonicalState(state);
  const pagination = {
    olderCursor: null,
    backwardsCursor: null,
    oldestLoadedTurnId: input.turns[0]?.id ?? null,
    isLoadingOlder: false,
    hasLoadedOldest: true,
    loadedTurnCount: input.turns.length,
    itemsView: "full" as const,
  };
  aggregate.installSnapshot({
    threadId: runtimeThreadId,
    canonicalState: state,
    turns: input.turns.map((turn) => ({
      threadId: runtimeThreadId,
      turnId: turn.id,
      status: turn.status,
      itemIds: turn.items.map((item) => item.id),
      items: [],
    })),
    turnPagination: pagination,
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
  } as unknown as CodexConversationSnapshot);
  aggregate.initializeHistory(pagination, input.turns.length, input.itemsPaginationByTurnId);
  const conversations = ConversationEntityMap.of({
    entity: registry.acquire,
    current: registry.current,
    runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) => operation,
    markAllNeedsResume: registry.markAllNeedsResume,
    retire: () => Effect.void,
  });
  return { aggregate, conversations, pagination };
};

const runtimeCapabilities = CodexAppServerCapabilities.of({
  forThread: () =>
    Effect.succeed({
      hostId: "host-search",
      generation: 4,
      userAgent: "Codex Desktop/test",
      version: "test",
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
    }),
  forHost: () => Effect.die("unused"),
  isCurrent: () => Effect.succeed(true),
});

const selectedSearchTurn = (): Turn => ({
  ...rawTurn(selectedOccurrence.turnId, 50),
  itemsView: "full",
  items: [
    {
      type: "userMessage",
      id: selectedOccurrence.itemId,
      clientId: null,
      content: [{ type: "text", text: "needle", text_elements: [] }],
    },
  ],
});

const runtimeOccurrenceHydration = (hydrateTurn: Turn, islandId: string) => ({
  threadId: runtimeThreadId,
  hostId: "host-search",
  generation: 4,
  occurrence: selectedOccurrence,
  turns: [hydrateTurn],
  itemsPaginationByTurnId: {
    [hydrateTurn.id]: fullItemsPagination,
  },
  selection: {
    status: "found" as const,
    item: hydrateTurn.items[0]!,
    inspectedItemCount: 1,
    inspectedBytes: 32,
  },
  island: {
    islandId,
    entries: [{ key: hydrateTurn.id, entityKey: hydrateTurn.id }],
    entities: [
      {
        key: hydrateTurn.id,
        turn: hydrateTurn,
        itemCount: hydrateTurn.items.length,
        approximateBytes: 32,
        itemsPagination: fullItemsPagination,
        authority: "history" as const,
        revision: 1,
      },
    ],
    olderBoundary: opaqueCodexHistoryBoundary(`${islandId}:older`),
    newerBoundary: opaqueCodexHistoryBoundary(`${islandId}:newer`),
  },
});

const runtimeSearchAdapter = (input: {
  readonly hydrateTurn: Turn;
  readonly onHydrate?: () => void;
}) =>
  CodexHistorySearchAdapter.of({
    search: () =>
      Effect.succeed({
        threadId: runtimeThreadId,
        hostId: "host-search",
        generation: 4,
        occurrences: [selectedOccurrence],
        isCapped: false,
      }),
    hydrateOccurrence: () =>
      Effect.sync(() => {
        input.onHydrate?.();
        return runtimeOccurrenceHydration(input.hydrateTurn, "search:runtime");
      }),
  });

const availableHistoryFeatures = CodexThreadHistoryFeatures.of({
  resolve: (threadId, feature) =>
    Effect.succeed({
      status: "available",
      feature,
      threadId,
      historyMode: "paginated",
      capability: {
        hostId: "host-search",
        generation: 4,
        userAgent: "Codex Desktop/test",
        version: "test",
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
      },
    }),
});

const makeRuntime = (input: {
  readonly conversations: ConversationEntityMap["Service"];
  readonly searchAdapter: CodexHistorySearchAdapter["Service"];
  readonly historyFeatures?: CodexThreadHistoryFeatures["Service"];
  readonly onItemPage?: () => void;
}) =>
  makePersistedHistorySearchRuntime.pipe(
    Effect.provideService(ConversationEntityMap, input.conversations),
    Effect.provideService(CodexHistorySearchAdapter, input.searchAdapter),
    Effect.provideService(
      CodexThreadHistoryFeatures,
      input.historyFeatures ?? availableHistoryFeatures,
    ),
    Effect.provideService(
      CodexConversationHistoryRuntime,
      CodexConversationHistoryRuntime.of({
        loadPage: () =>
          Effect.sync(() => {
            input.onItemPage?.();
            throw new Error("unexpected history page");
          }),
        clear: () => undefined,
      }),
    ),
    Effect.provideService(CodexAppServerCapabilities, runtimeCapabilities),
  );

const completedSearch = Effect.fn("CodexPersistedHistorySearchRuntimeTest.completedSearch")(
  function* (runtime: CodexPersistedHistorySearchRuntime["Service"], query: string) {
    const result = yield* runtime.search(runtimeThreadId, query);
    assert.strictEqual(result.status, "completed");
    if (result.status !== "completed") return yield* Effect.die("Expected completed search");
    return result.page;
  },
);

it.effect("returns persisted-search unavailability without calling the physical adapter", () =>
  Effect.gen(function* () {
    const installed = installRuntimeConversation({ turns: [rawTurn("turn-tail", 100)] });
    let physicalSearches = 0;
    const unavailable = {
      status: "unavailable",
      feature: "persisted-search",
      reason: "capability-unproven",
      threadId: runtimeThreadId,
      hostId: "host-search",
      hostGeneration: 4,
      sourceEpoch: "epoch-search",
      appServerVersion: "0.0.0",
      historyMode: "paginated",
    } as const;
    const runtime = yield* makeRuntime({
      conversations: installed.conversations,
      searchAdapter: CodexHistorySearchAdapter.of({
        search: () =>
          Effect.sync(() => {
            physicalSearches += 1;
            return {} as never;
          }),
        hydrateOccurrence: () => Effect.die("unused"),
      }),
      historyFeatures: CodexThreadHistoryFeatures.of({
        resolve: () => Effect.succeed(unavailable),
      }),
    });

    const result = yield* runtime.search(runtimeThreadId, "needle");

    assert.deepStrictEqual(result, unavailable);
    assert.strictEqual(physicalSearches, 0);
  }),
);

it.effect("preserves physical search failures instead of disguising them as unavailability", () =>
  Effect.gen(function* () {
    const installed = installRuntimeConversation({ turns: [rawTurn("turn-tail", 100)] });
    const runtime = yield* makeRuntime({
      conversations: installed.conversations,
      searchAdapter: CodexHistorySearchAdapter.of({
        search: () =>
          Effect.fail(
            new CodexHistorySearchAdapterError({
              operation: "search",
              threadId: runtimeThreadId,
              turnId: null,
              reason: "request-failed",
              cause: new Error("transport closed"),
            }),
          ),
        hydrateOccurrence: () => Effect.die("unused"),
      }),
    });

    const failure = yield* runtime.search(runtimeThreadId, "needle").pipe(Effect.flip);

    assert.strictEqual(failure.reason, "request-failed");
    assert.strictEqual(failure.operation, "search");
  }),
);

it("aligns an overlapping search window relative to the first resident anchor", () => {
  const [turnA, turnB, turnC] = canonicalTurns([
    rawTurn("turn-a", 10),
    rawTurn("turn-b", 20),
    rawTurn("turn-c", 30),
  ]);
  const initial = createCodexHistoryIslandTopology({
    generation: 3,
    islandId: "tail:3",
    entries: [turnA!, turnB!, turnC!].map((turn) => ({
      key: turn.protocol.id!,
      entityKey: turn.protocol.id!,
    })),
    entities: [entity(turnA!), entity(turnB!), entity(turnC!)],
    olderBoundary: availableCodexHistoryBoundary("tail:older", {
      cursor: "older",
      oldestLoadedTurnId: "turn-a",
    }),
    newerBoundary: exhaustedCodexHistoryBoundary("tail:newer"),
  });
  if (!initial.ok) throw new Error(initial.error.message);
  const [turnX, searchB, searchC, turnD] = canonicalTurns([
    rawTurn("turn-x", 15),
    rawTurn("turn-b", 20),
    rawTurn("turn-c", 30),
    rawTurn("turn-d", 40),
  ]);

  const placement = placeCodexHistorySearchIsland({
    topology: initial.topology,
    turns: [turnX!, searchB!, searchC!, turnD!],
  });

  assert.deepEqual(placement, {
    index: 0,
    positionsByEntityKey: {
      "turn-a": 0,
      "turn-b": 5,
      "turn-c": 6,
      "turn-x": 4,
      "turn-d": 7,
    },
  });
});

it("places a disjoint timestamped island between existing sparse islands", () => {
  const [oldTurn, tailTurn, middleTurn] = canonicalTurns([
    rawTurn("turn-old", 10),
    rawTurn("turn-tail", 100),
    rawTurn("turn-middle", 50),
  ]);
  const older = createCodexHistoryIslandTopology({
    generation: 8,
    islandId: "search:old",
    entries: [{ key: oldTurn!.protocol.id!, entityKey: oldTurn!.protocol.id! }],
    entities: [entity(oldTurn!)],
    olderBoundary: opaqueCodexHistoryBoundary("search:old:older"),
    newerBoundary: opaqueCodexHistoryBoundary("search:old:newer"),
  });
  if (!older.ok) throw new Error(older.error.message);
  const topology = insertCodexHistoryIsland(older.topology, {
    index: 1,
    islandId: "tail:8",
    entries: [{ key: tailTurn!.protocol.id!, entityKey: tailTurn!.protocol.id! }],
    entities: [entity(tailTurn!)],
    olderBoundary: opaqueCodexHistoryBoundary("tail:older"),
    newerBoundary: exhaustedCodexHistoryBoundary("tail:newer"),
  });
  if (!topology.ok) throw new Error(topology.error.message);

  const placement = placeCodexHistorySearchIsland({
    topology: topology.topology,
    turns: [middleTurn!],
  });

  assert.strictEqual(placement?.index, 1);
  assert.deepEqual(placement?.positionsByEntityKey, {
    "turn-old": 0,
    "turn-middle": 1,
    "turn-tail": 2,
  });
});

it("refuses to guess placement when a disjoint Turn has no startedAt", () => {
  const [tailTurn, unknownTurn] = canonicalTurns([
    rawTurn("turn-tail", 100),
    rawTurn("turn-unknown", null),
  ]);
  const topology = createCodexHistoryIslandTopology({
    generation: 1,
    islandId: "tail:1",
    entries: [{ key: tailTurn!.protocol.id!, entityKey: tailTurn!.protocol.id! }],
    entities: [entity(tailTurn!)],
    olderBoundary: opaqueCodexHistoryBoundary("tail:older"),
    newerBoundary: exhaustedCodexHistoryBoundary("tail:newer"),
  });
  if (!topology.ok) throw new Error(topology.error.message);

  assert.isNull(
    placeCodexHistorySearchIsland({ topology: topology.topology, turns: [unknownTurn!] }),
  );
});

it.effect("returns the committed topology generation with a bounded search island", () =>
  Effect.gen(function* () {
    const installed = installRuntimeConversation({ turns: [rawTurn("turn-tail", 100)] });
    let physicalHydrations = 0;
    const runtime = yield* makeRuntime({
      conversations: installed.conversations,
      searchAdapter: runtimeSearchAdapter({
        hydrateTurn: selectedSearchTurn(),
        onHydrate: () => {
          physicalHydrations += 1;
        },
      }),
    });

    const page = yield* completedSearch(runtime, "needle");
    const hydrated = yield* runtime.hydrateOccurrence({
      requestId: "hydrate-committed",
      threadId: runtimeThreadId,
      hostId: page.hostId,
      hostGeneration: page.hostGeneration,
      topologyGeneration: page.topologyGeneration,
      occurrence: page.occurrences[0]!,
    });

    assert.strictEqual(hydrated.status, "found");
    assert.strictEqual(physicalHydrations, 1);
    assert.strictEqual(hydrated.topologyGeneration, page.topologyGeneration);
    assert.strictEqual(
      hydrated.topologyGeneration,
      installed.aggregate.readHistoryTopology().generation,
    );
    assert.strictEqual(hydrated.mutation?.topologyGeneration, hydrated.topologyGeneration);
    assert.isDefined(
      installed.aggregate.readHistoryTopology().entitiesByKey[selectedOccurrence.turnId],
    );
  }),
);

it.effect("rejects a stale topology before the physical search hydration", () =>
  Effect.gen(function* () {
    const installed = installRuntimeConversation({ turns: [rawTurn("turn-tail", 100)] });
    let physicalHydrations = 0;
    const runtime = yield* makeRuntime({
      conversations: installed.conversations,
      searchAdapter: runtimeSearchAdapter({
        hydrateTurn: selectedSearchTurn(),
        onHydrate: () => {
          physicalHydrations += 1;
        },
      }),
    });
    const page = yield* completedSearch(runtime, "needle");
    installed.aggregate.initializeHistory(installed.pagination, 1);

    const stale = yield* Effect.result(
      runtime.hydrateOccurrence({
        requestId: "hydrate-stale-before",
        threadId: runtimeThreadId,
        hostId: page.hostId,
        hostGeneration: page.hostGeneration,
        topologyGeneration: page.topologyGeneration,
        occurrence: page.occurrences[0]!,
      }),
    );

    assert(Result.isFailure(stale));
    assert.strictEqual(stale.failure.reason, "stale-generation");
    assert.strictEqual(physicalHydrations, 0);
  }),
);

it.effect("rejects a topology replacement that races the physical search hydration", () =>
  Effect.gen(function* () {
    const installed = installRuntimeConversation({ turns: [rawTurn("turn-tail", 100)] });
    let physicalHydrations = 0;
    const runtime = yield* makeRuntime({
      conversations: installed.conversations,
      searchAdapter: runtimeSearchAdapter({
        hydrateTurn: selectedSearchTurn(),
        onHydrate: () => {
          physicalHydrations += 1;
          installed.aggregate.initializeHistory(installed.pagination, 1);
        },
      }),
    });
    const page = yield* completedSearch(runtime, "needle");

    const stale = yield* Effect.result(
      runtime.hydrateOccurrence({
        requestId: "hydrate-stale-race",
        threadId: runtimeThreadId,
        hostId: page.hostId,
        hostGeneration: page.hostGeneration,
        topologyGeneration: page.topologyGeneration,
        occurrence: page.occurrences[0]!,
      }),
    );

    assert(Result.isFailure(stale));
    assert.strictEqual(stale.failure.reason, "stale-generation");
    assert.strictEqual(physicalHydrations, 1);
    assert.isUndefined(
      installed.aggregate.readHistoryTopology().entitiesByKey[selectedOccurrence.turnId],
    );
  }),
);

it.effect("rejects a stale resident-item retry before loading its next physical page", () =>
  Effect.gen(function* () {
    const partialTurn = rawTurn(selectedOccurrence.turnId, 50);
    const partialPagination: CodexHistoryTurnItemsPagination = {
      ...fullItemsPagination,
      olderCursor: "items:older",
      hasLoadedOldest: false,
      itemsView: "summary",
    };
    const installed = installRuntimeConversation({
      turns: [partialTurn],
      itemsPaginationByTurnId: { [partialTurn.id]: partialPagination },
    });
    let itemPageReads = 0;
    const runtime = yield* makeRuntime({
      conversations: installed.conversations,
      searchAdapter: runtimeSearchAdapter({ hydrateTurn: selectedSearchTurn() }),
      onItemPage: () => {
        itemPageReads += 1;
      },
    });
    const page = yield* completedSearch(runtime, "needle");
    installed.aggregate.initializeHistory(installed.pagination, 1, {
      [partialTurn.id]: partialPagination,
    });

    const stale = yield* Effect.result(
      runtime.hydrateOccurrence({
        requestId: "hydrate-resident-stale",
        threadId: runtimeThreadId,
        hostId: page.hostId,
        hostGeneration: page.hostGeneration,
        topologyGeneration: page.topologyGeneration,
        occurrence: page.occurrences[0]!,
      }),
    );

    assert(Result.isFailure(stale));
    assert.strictEqual(stale.failure.reason, "stale-generation");
    assert.strictEqual(itemPageReads, 0);
  }),
);

it.effect("does not commit a hydration that finishes after a newer navigation", () =>
  Effect.gen(function* () {
    const installed = installRuntimeConversation({ turns: [rawTurn("turn-tail", 100)] });
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    let hydrationCall = 0;
    const searchAdapter = CodexHistorySearchAdapter.of({
      search: () =>
        Effect.succeed({
          threadId: runtimeThreadId,
          hostId: "host-search",
          generation: 4,
          occurrences: [selectedOccurrence],
          isCapped: false,
        }),
      hydrateOccurrence: () =>
        Effect.gen(function* () {
          hydrationCall += 1;
          const call = hydrationCall;
          if (call === 1) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          }
          return runtimeOccurrenceHydration(selectedSearchTurn(), `search:runtime:${call}`);
        }),
    });
    const runtime = yield* makeRuntime({
      conversations: installed.conversations,
      searchAdapter,
    });
    const page = yield* completedSearch(runtime, "needle");
    const request = (requestId: string) => ({
      requestId,
      threadId: runtimeThreadId,
      hostId: page.hostId,
      hostGeneration: page.hostGeneration,
      topologyGeneration: page.topologyGeneration,
      occurrence: page.occurrences[0]!,
    });

    const first = yield* runtime
      .hydrateOccurrence(request("hydrate-first"))
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(firstStarted);
    const second = yield* runtime.hydrateOccurrence(request("hydrate-second"));
    yield* Deferred.succeed(releaseFirst, undefined);
    const firstResult = yield* Fiber.join(first);

    assert.strictEqual(second.status, "found");
    assert(Result.isFailure(firstResult));
    assert.strictEqual(firstResult.failure.reason, "superseded");
    assert.deepEqual(
      installed.aggregate.readHistoryTopology().islands.map((island) => island.id),
      ["search:runtime:2", "tail:1"],
    );
  }),
);
