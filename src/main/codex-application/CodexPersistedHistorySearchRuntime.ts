import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { CodexCanonicalConversationState } from "../../shared/types";
import type {
  CodexPersistedHistoryOccurrenceHydrateRequest,
  CodexPersistedHistoryOccurrenceHydrateResult,
  CodexPersistedHistoryOccurrenceResolution,
  CodexPersistedHistorySearchPage,
} from "../../shared/codex-persisted-history-search";
import type { CodexCanonicalHistoryTopology } from "../../shared/codex-conversation-state/codex-history-topology";
import { createCodexConversationHistoryTurnItemsRef } from "../../shared/codex-conversation-history-page";
import type { CodexCanonicalTurnState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import {
  CodexHistorySearchAdapter,
  type CodexHistoryOccurrenceHydration,
} from "./CodexHistorySearchAdapter";
import { projectCodexConversationOlderTurns } from "./CodexConversationHistoryProjection";
import { CodexConversationHistoryRuntime } from "./CodexConversationHistoryRuntime";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export interface CodexHistorySearchPlacement {
  readonly index: number;
  readonly positionsByEntityKey: Readonly<Record<string, number>>;
}

export class CodexPersistedHistorySearchError extends Data.TaggedError(
  "CodexPersistedHistorySearchError",
)<{
  readonly operation: "search" | "hydrate" | "retry" | "placement";
  readonly threadId: string;
  readonly reason:
    | "conversation-missing"
    | "stale-generation"
    | "superseded"
    | "placement-failed"
    | "selected-item-missing"
    | "request-failed";
  readonly cause: unknown;
}> {}

export class CodexPersistedHistorySearchRuntime extends Context.Service<
  CodexPersistedHistorySearchRuntime,
  {
    readonly search: (
      threadId: string,
      query: string,
    ) => Effect.Effect<CodexPersistedHistorySearchPage, CodexPersistedHistorySearchError>;
    readonly hydrateOccurrence: (
      input: CodexPersistedHistoryOccurrenceHydrateRequest,
    ) => Effect.Effect<
      CodexPersistedHistoryOccurrenceHydrateResult,
      CodexPersistedHistorySearchError
    >;
  }
>()("nodex/main/codex-application/CodexPersistedHistorySearchRuntime") {}

const runtimeError = (input: {
  readonly operation: CodexPersistedHistorySearchError["operation"];
  readonly threadId: string;
  readonly reason: CodexPersistedHistorySearchError["reason"];
  readonly cause: unknown;
}) => new CodexPersistedHistorySearchError(input);

const persistedTurnId = (turn: CodexCanonicalTurnState): string | null => turn.protocol.id;

const startedAt = (turn: CodexCanonicalTurnState): number | null =>
  turn.sidecar.turnStartedAtMs ?? null;

/** Mirrors the desktop search-island position map, including anchor-relative alignment. */
export function placeCodexHistorySearchIsland(input: {
  readonly topology: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
  readonly turns: readonly CodexCanonicalTurnState[];
}): CodexHistorySearchPlacement | null {
  if (input.turns.length === 0) return null;
  const existingPositions = new Map<string, number>();
  const existingEntityKeyByTurnId = new Map<string, string>();
  const step = input.turns.length + 1;
  let position = 0;
  for (const island of input.topology.islands) {
    for (const entry of island.entries) {
      existingPositions.set(entry.entityKey, position);
      const turnId = persistedTurnId(input.topology.entitiesByKey[entry.entityKey]!.turn);
      if (turnId !== null) existingEntityKeyByTurnId.set(turnId, entry.entityKey);
      position += step;
    }
    position += step;
  }

  const firstOverlapIndex = input.turns.findIndex((turn) => {
    const turnId = persistedTurnId(turn);
    return turnId !== null && existingEntityKeyByTurnId.has(turnId);
  });
  const positions = new Map(existingPositions);
  if (firstOverlapIndex !== -1) {
    const anchorTurnId = persistedTurnId(input.turns[firstOverlapIndex]!);
    const anchorEntityKey =
      anchorTurnId === null ? null : (existingEntityKeyByTurnId.get(anchorTurnId) ?? null);
    const anchorPosition = anchorEntityKey === null ? null : existingPositions.get(anchorEntityKey);
    if (anchorPosition === null || anchorPosition === undefined) return null;
    for (const [index, turn] of input.turns.entries()) {
      const turnId = persistedTurnId(turn);
      if (turnId === null) return null;
      positions.set(turnId, anchorPosition + index - firstOverlapIndex);
    }
  } else {
    const turnsByKey = new Map<string, CodexCanonicalTurnState>();
    for (const island of input.topology.islands) {
      for (const entry of island.entries) {
        turnsByKey.set(entry.entityKey, input.topology.entitiesByKey[entry.entityKey]!.turn);
      }
    }
    for (const turn of input.turns) {
      const turnId = persistedTurnId(turn);
      if (turnId === null) return null;
      turnsByKey.set(turnId, turn);
    }
    const ordered = [...turnsByKey.entries()];
    if (ordered.some(([, turn]) => startedAt(turn) === null)) return null;
    ordered.sort(([leftKey, left], [rightKey, right]) => {
      const delta = startedAt(left)! - startedAt(right)!;
      return delta === 0 ? leftKey.localeCompare(rightKey) : delta;
    });
    positions.clear();
    for (const [index, [key]] of ordered.entries()) positions.set(key, index);
  }

  const newKeys = input.turns.map(persistedTurnId);
  if (newKeys.some((key) => key === null)) return null;
  const newPositions = newKeys.map((key) => positions.get(key!));
  if (newPositions.some((value) => value === undefined)) return null;
  const minimum = Math.min(...(newPositions as number[]));
  const maximum = Math.max(...(newPositions as number[]));
  const overlappingIslandIndexes = input.topology.islands.flatMap((island, index) =>
    island.entries.some((entry) => newKeys.includes(entry.entityKey)) ? [index] : [],
  );
  let islandIndex = overlappingIslandIndexes[0] ?? input.topology.islands.length;
  if (overlappingIslandIndexes.length === 0) {
    for (const [index, island] of input.topology.islands.entries()) {
      const islandPositions = island.entries.map((entry) => positions.get(entry.entityKey)!);
      const islandMinimum = Math.min(...islandPositions);
      const islandMaximum = Math.max(...islandPositions);
      if (maximum < islandMinimum) {
        islandIndex = index;
        break;
      }
      if (minimum <= islandMaximum) return null;
    }
  }
  return {
    index: islandIndex,
    positionsByEntityKey: Object.fromEntries(positions),
  };
}

const findCanonicalItem = (
  state: CodexCanonicalConversationState,
  turnId: string,
  itemId: string,
): boolean =>
  state.turns
    .find((turn) => turn.protocol.id === turnId)
    ?.items.some((item) => item.id === itemId) === true;

const orderProjectedSearchState = (input: {
  readonly current: CodexCanonicalConversationState;
  readonly projected: CodexCanonicalConversationState;
  readonly placement: CodexHistorySearchPlacement;
}): CodexCanonicalConversationState => {
  const turnsById = new Map<string, CodexCanonicalTurnState>();
  for (const turn of input.current.turns) {
    const turnId = persistedTurnId(turn);
    if (turnId !== null) turnsById.set(turnId, turn);
  }
  for (const turn of input.projected.turns) {
    const turnId = persistedTurnId(turn);
    if (turnId !== null) turnsById.set(turnId, turn);
  }
  const orderedIds = Object.entries(input.placement.positionsByEntityKey)
    .sort((left, right) => left[1] - right[1])
    .map(([turnId]) => turnId);
  const represented = new Set(orderedIds);
  const ordered = orderedIds.flatMap((turnId) => {
    const turn = turnsById.get(turnId);
    return turn ? [turn] : [];
  });
  const unpositioned = input.projected.turns.filter((turn) => {
    const turnId = persistedTurnId(turn);
    return turnId !== null && !represented.has(turnId);
  });
  const synthetic = input.projected.turns.filter((turn) => persistedTurnId(turn) === null);
  return { ...input.projected, turns: [...ordered, ...unpositioned, ...synthetic] };
};

type RuntimeOccurrenceResolution =
  | { readonly status: "found" }
  | {
      readonly status: "bounded-incomplete";
      readonly reason: Extract<
        CodexPersistedHistoryOccurrenceResolution,
        { readonly status: "bounded-incomplete" }
      >["reason"];
    };

export const CODEX_PERSISTED_HISTORY_MAX_TRACKED_HYDRATION_THREADS = 256;

/**
 * Tracks only live navigation requests. Same-Thread replacement remains last-write-wins, while
 * cross-Thread pressure evicts the least-recently-started request so historical ids cannot make
 * the Main-scoped index grow forever. An evicted request fails its next commit fence as superseded.
 */
export const makePersistedHistoryHydrationRequestTracker = (
  capacity = CODEX_PERSISTED_HISTORY_MAX_TRACKED_HYDRATION_THREADS,
) => {
  const maximum = Number.isSafeInteger(capacity) && capacity > 0 ? capacity : 1;
  const latestByThread = new Map<string, string>();
  return {
    begin(threadId: string, requestId: string): void {
      if (latestByThread.has(threadId)) latestByThread.delete(threadId);
      while (latestByThread.size >= maximum) {
        const oldestThreadId = latestByThread.keys().next().value as string | undefined;
        if (oldestThreadId === undefined) break;
        latestByThread.delete(oldestThreadId);
      }
      latestByThread.set(threadId, requestId);
    },
    isLatest(threadId: string, requestId: string): boolean {
      return latestByThread.get(threadId) === requestId;
    },
    complete(threadId: string, requestId: string): void {
      if (latestByThread.get(threadId) === requestId) latestByThread.delete(threadId);
    },
    size(): number {
      return latestByThread.size;
    },
  };
};

export const make: Effect.Effect<
  CodexPersistedHistorySearchRuntime["Service"],
  never,
  | CodexAppServerCapabilities
  | CodexConversationHistoryRuntime
  | CodexHistorySearchAdapter
  | ConversationEntityMap
> = Effect.gen(function* () {
  const capabilities = yield* CodexAppServerCapabilities;
  const historyRuntime = yield* CodexConversationHistoryRuntime;
  const searchAdapter = yield* CodexHistorySearchAdapter;
  const conversations = yield* ConversationEntityMap;
  const hydrationRequests = makePersistedHistoryHydrationRequestTracker();

  const isLatestHydrationRequest = (
    input: CodexPersistedHistoryOccurrenceHydrateRequest,
  ): boolean => hydrationRequests.isLatest(input.threadId, input.requestId);

  const assertLatestHydrationRequest = Effect.fn(
    "CodexPersistedHistorySearchRuntime.assertLatestHydrationRequest",
  )(function* (input: CodexPersistedHistoryOccurrenceHydrateRequest) {
    if (isLatestHydrationRequest(input)) return;
    return yield* runtimeError({
      operation: "hydrate",
      threadId: input.threadId,
      reason: "superseded",
      cause: new Error("Persisted-history hydration was superseded by a newer navigation"),
    });
  });

  const assertHostGeneration = Effect.fn("CodexPersistedHistorySearchRuntime.assertHostGeneration")(
    function* (input: CodexPersistedHistoryOccurrenceHydrateRequest) {
      const snapshot = yield* capabilities.forThread(input.threadId).pipe(
        Effect.mapError((cause) =>
          runtimeError({
            operation: "retry",
            threadId: input.threadId,
            reason: "request-failed",
            cause,
          }),
        ),
      );
      if (snapshot.hostId === input.hostId && snapshot.generation === input.hostGeneration) {
        return snapshot;
      }
      return yield* runtimeError({
        operation: "retry",
        threadId: input.threadId,
        reason: "stale-generation",
        cause: new Error("Persisted-history occurrence belongs to a stale Codex session"),
      });
    },
  );

  const result = Effect.fn("CodexPersistedHistorySearchRuntime.result")(function* (
    input: CodexPersistedHistoryOccurrenceHydrateRequest,
    resolution: RuntimeOccurrenceResolution,
    mutation: CodexPersistedHistoryOccurrenceHydrateResult["mutation"] = null,
  ) {
    const aggregate = conversations.current(input.threadId);
    if (!aggregate?.readSnapshot()) {
      return yield* runtimeError({
        operation: "hydrate",
        threadId: input.threadId,
        reason: "conversation-missing",
        cause: new Error("Conversation disappeared while hydrating persisted history"),
      });
    }
    return {
      ...resolution,
      threadId: input.threadId,
      turnId: input.occurrence.turnId,
      itemId: input.occurrence.itemId,
      topologyGeneration: aggregate.readHistoryTopology().generation,
      mutation,
    } as CodexPersistedHistoryOccurrenceHydrateResult;
  });

  const retryResidentTurn = Effect.fn("CodexPersistedHistorySearchRuntime.retryResidentTurn")(
    function* (input: CodexPersistedHistoryOccurrenceHydrateRequest) {
      const aggregate = conversations.current(input.threadId);
      const state = aggregate?.readCanonicalState();
      const snapshot = aggregate?.readSnapshot();
      const pagination = aggregate?.readTurnItemsPagination(input.occurrence.turnId);
      if (!aggregate || !state || !snapshot || !pagination) return null;
      if (aggregate.readHistoryTopology().generation !== input.topologyGeneration) {
        return yield* runtimeError({
          operation: "retry",
          threadId: input.threadId,
          reason: "stale-generation",
          cause: new Error("Conversation history generation changed before selected-item retry"),
        });
      }
      if (!aggregate.readHistoryTopology().entitiesByKey[input.occurrence.turnId]) return null;
      if (findCanonicalItem(state, input.occurrence.turnId, input.occurrence.itemId)) {
        return yield* result(input, { status: "found" });
      }
      const itemRef = createCodexConversationHistoryTurnItemsRef({
        turnId: input.occurrence.turnId,
        expectedTopologyGeneration: input.topologyGeneration,
        pagination,
        edge: "older",
        window: snapshot.historyItemWindowsByTurnId?.[input.occurrence.turnId] ?? null,
      });
      if (!itemRef) {
        return yield* runtimeError({
          operation: "retry",
          threadId: input.threadId,
          reason: "selected-item-missing",
          cause: new Error("Persisted-history item is no longer present in its Turn"),
        });
      }

      yield* assertLatestHydrationRequest(input);
      const hostSnapshot = yield* assertHostGeneration(input);
      const page = yield* historyRuntime
        .loadPage({
          threadId: input.threadId,
          expectedConversationGeneration: aggregate.generation,
          expectedHistoryMutationRevision: snapshot.historyMutationRevision ?? 0,
          target: { kind: "turnItems", items: itemRef },
        })
        .pipe(
          Effect.mapError((cause) =>
            runtimeError({
              operation: "retry",
              threadId: input.threadId,
              reason: "request-failed",
              cause,
            }),
          ),
        );
      yield* assertLatestHydrationRequest(input);
      const stillCurrent = yield* capabilities.isCurrent(hostSnapshot).pipe(
        Effect.mapError((cause) =>
          runtimeError({
            operation: "retry",
            threadId: input.threadId,
            reason: "request-failed",
            cause,
          }),
        ),
      );
      if (
        !stillCurrent ||
        conversations.current(input.threadId) !== aggregate ||
        aggregate.readHistoryTopology().generation !== input.topologyGeneration
      ) {
        return yield* runtimeError({
          operation: "retry",
          threadId: input.threadId,
          reason: "stale-generation",
          cause: new Error(
            "Codex session or conversation history changed while loading the selected item page",
          ),
        });
      }
      const latest = aggregate.readCanonicalState();
      if (latest && findCanonicalItem(latest, input.occurrence.turnId, input.occurrence.itemId)) {
        return yield* result(input, { status: "found" }, page.mutation);
      }
      return yield* result(
        input,
        { status: "bounded-incomplete", reason: "next-item-page-required" },
        page.mutation,
      );
    },
  );

  const search = Effect.fn("CodexPersistedHistorySearchRuntime.search")(function* (
    threadId: string,
    query: string,
  ) {
    const page = yield* searchAdapter
      .search({ threadId, searchTerm: query })
      .pipe(
        Effect.mapError((cause) =>
          runtimeError({ operation: "search", threadId, reason: "request-failed", cause }),
        ),
      );
    const aggregate = conversations.current(threadId);
    if (!aggregate?.readSnapshot()) {
      return yield* runtimeError({
        operation: "search",
        threadId,
        reason: "conversation-missing",
        cause: new Error("Conversation disappeared while searching persisted history"),
      });
    }
    return {
      threadId,
      query,
      hostId: page.hostId,
      hostGeneration: page.generation,
      topologyGeneration: aggregate.readHistoryTopology().generation,
      occurrences: [...page.occurrences],
      capped: page.isCapped,
    } satisfies CodexPersistedHistorySearchPage;
  });

  const hydrateOccurrencePhysical = Effect.fn(
    "CodexPersistedHistorySearchRuntime.hydrateOccurrencePhysical",
  )(function* (input: CodexPersistedHistoryOccurrenceHydrateRequest) {
    const resident = yield* retryResidentTurn(input);
    if (resident) return resident;

    const aggregate = conversations.current(input.threadId);
    if (
      !aggregate?.readSnapshot() ||
      aggregate.readHistoryTopology().generation !== input.topologyGeneration
    ) {
      return yield* runtimeError({
        operation: "hydrate",
        threadId: input.threadId,
        reason: "stale-generation",
        cause: new Error("Conversation history generation changed before hydration"),
      });
    }
    const entityGeneration = aggregate.generation;
    const hydration: CodexHistoryOccurrenceHydration = yield* searchAdapter
      .hydrateOccurrence({
        threadId: input.threadId,
        hostId: input.hostId,
        generation: input.hostGeneration,
        occurrence: input.occurrence,
      })
      .pipe(
        Effect.mapError((cause) =>
          runtimeError({
            operation: "hydrate",
            threadId: input.threadId,
            reason: "request-failed",
            cause,
          }),
        ),
      );
    yield* assertLatestHydrationRequest(input);

    const committed = yield* conversations.runCommand(
      input.threadId,
      Effect.try({
        try: () => {
          const currentAggregate = conversations.current(input.threadId);
          const current = currentAggregate?.readCanonicalState();
          const topology = currentAggregate?.readHistoryTopology();
          if (
            !isLatestHydrationRequest(input) ||
            currentAggregate !== aggregate ||
            currentAggregate?.generation !== entityGeneration ||
            !current ||
            !topology ||
            topology.generation !== input.topologyGeneration
          ) {
            return { status: "stale" } as const;
          }
          const projected = projectCodexConversationOlderTurns({
            current,
            olderTurns: hydration.turns,
            oldestLoadedTurnId: null,
            itemsPaginationByTurnId: hydration.itemsPaginationByTurnId,
          });
          const projectedById = new Map(
            projected.turns.flatMap((turn) => {
              const turnId = persistedTurnId(turn);
              return turnId === null ? [] : [[turnId, turn] as const];
            }),
          );
          const islandTurns = hydration.turns.flatMap((turn) => {
            const projectedTurn = projectedById.get(turn.id);
            return projectedTurn ? [projectedTurn] : [];
          });
          const placement = placeCodexHistorySearchIsland({ topology, turns: islandTurns });
          if (!placement) return { status: "placement-failed" } as const;
          const state = orderProjectedSearchState({ current, projected, placement });
          return currentAggregate.insertHistoryIsland({
            mutationId: input.requestId,
            expectedTopologyGeneration: input.topologyGeneration,
            index: placement.index,
            islandId: hydration.island.islandId,
            state,
            turnIds: hydration.turns.map((turn) => turn.id),
            itemsPaginationByTurnId: hydration.itemsPaginationByTurnId,
            olderBoundary: hydration.island.olderBoundary,
            newerBoundary: hydration.island.newerBoundary,
            positionsByEntityKey: placement.positionsByEntityKey,
            observedAtMs: Date.now(),
            projectReplica: false,
          });
        },
        catch: (cause) =>
          runtimeError({
            operation: "placement",
            threadId: input.threadId,
            reason: "placement-failed",
            cause,
          }),
      }),
    );
    if (committed.status === "stale" || committed.status === "staleGeneration") {
      return yield* runtimeError({
        operation: "hydrate",
        threadId: input.threadId,
        reason: "stale-generation",
        cause: new Error("Conversation history generation changed during hydration"),
      });
    }
    if (committed.status === "placement-failed" || committed.status === "rejected") {
      return yield* runtimeError({
        operation: "placement",
        threadId: input.threadId,
        reason: "placement-failed",
        cause: new Error(
          committed.status === "rejected" ? committed.reason : "Search island could not be placed",
        ),
      });
    }
    if (hydration.selection.status === "found") {
      return yield* result(input, { status: "found" }, committed.mutation);
    }
    return yield* result(
      input,
      {
        status: "bounded-incomplete",
        reason: hydration.selection.reason,
      },
      committed.mutation,
    );
  });

  const hydrateOccurrence = (input: CodexPersistedHistoryOccurrenceHydrateRequest) =>
    Effect.sync(() => {
      hydrationRequests.begin(input.threadId, input.requestId);
    }).pipe(
      Effect.andThen(hydrateOccurrencePhysical(input)),
      Effect.ensuring(
        Effect.sync(() => {
          hydrationRequests.complete(input.threadId, input.requestId);
        }),
      ),
    );

  return CodexPersistedHistorySearchRuntime.of({ search, hydrateOccurrence });
});
