import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import {
  codexConversationHistoryPageRequestKey,
  type CodexConversationHistoryPageRequest,
  type CodexConversationHistoryPageResult,
} from "../../shared/codex-conversation-history-page";
import {
  availableCodexHistoryBoundary,
  exhaustedCodexHistoryBoundary,
  type CodexHistoryBoundary,
  type CodexHistoryBoundaryHandle,
} from "../../shared/codex-conversation-state/codex-history-topology";
import { DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS } from "../../shared/codex-conversation-state/codex-history-item-window";
import type { CodexCanonicalConversationState } from "../../shared/types";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import {
  projectCodexConversationTurnItemPage,
  projectCodexConversationOlderTurns,
} from "./CodexConversationHistoryProjection";
import {
  CodexHistoryPageAdapter,
  type CodexHydratedHistoryItemPage,
  type CodexHydratedHistoryTurnPage,
} from "./CodexHistoryPageAdapter";
import { CodexRendererConversationRegistry } from "./CodexRendererConversationRegistry";
import type { ConversationEntityState } from "./internal/ConversationEntityState";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export type CodexConversationHistoryErrorReason =
  | "not-loaded"
  | "unsupported"
  | "stale-generation"
  | "stale-target"
  | "physical-read"
  | "projection-rejected";

export class CodexConversationHistoryError extends Data.TaggedError(
  "CodexConversationHistoryError",
)<{ readonly reason: CodexConversationHistoryErrorReason; readonly cause: unknown }> {}

export class CodexConversationHistoryRuntime extends Context.Service<
  CodexConversationHistoryRuntime,
  {
    readonly loadPage: (
      request: CodexConversationHistoryPageRequest,
    ) => Effect.Effect<CodexConversationHistoryPageResult, CodexConversationHistoryError>;
    readonly clear: (threadId: string) => void;
  }
>()("nodex/main/codex-application/CodexConversationHistoryRuntime") {}

interface HistoryPageAdmission {
  readonly entity: ConversationEntityState;
  readonly state: CodexCanonicalConversationState;
  readonly boundaryHandle: CodexHistoryBoundaryHandle | null;
  readonly itemCursor: string | null;
}

const historyError = (
  reason: CodexConversationHistoryErrorReason,
  cause: unknown,
): CodexConversationHistoryError => new CodexConversationHistoryError({ reason, cause });

const readBoundaryHandle = (
  entity: ConversationEntityState,
  target: Extract<CodexConversationHistoryPageRequest["target"], { kind: "turnBoundary" }>,
): CodexHistoryBoundaryHandle | null => {
  const topology = entity.readHistoryTopology();
  const island = topology.islands.find((candidate) => candidate.id === target.boundary.islandId);
  const boundary = target.boundary.edge === "older" ? island?.olderBoundary : island?.newerBoundary;
  if (
    boundary?.status !== "available" ||
    boundary.boundaryId !== target.boundary.boundaryId ||
    boundary.progressKey !== target.boundary.progressKey
  ) {
    return null;
  }
  return boundary.handle;
};

const continuationForPage = (input: {
  readonly boundaryId: string;
  readonly previous: CodexHistoryBoundaryHandle;
  readonly nextCursor: string | null;
  readonly oldestLoadedTurnId: string | null;
}): CodexHistoryBoundary =>
  input.nextCursor === null
    ? exhaustedCodexHistoryBoundary(input.boundaryId)
    : availableCodexHistoryBoundary(input.boundaryId, {
        cursor: input.nextCursor,
        oldestLoadedTurnId: input.oldestLoadedTurnId ?? input.previous.oldestLoadedTurnId,
      });

/** One exact request performs one physical app-server page under a target residency lease. */
export const make: Effect.Effect<
  CodexConversationHistoryRuntime["Service"],
  never,
  | CodexAppServerCapabilities
  | CodexHistoryPageAdapter
  | CodexRendererConversationRegistry
  | ConversationEntityMap
  | Scope.Scope
> = Effect.gen(function* () {
  const capabilities = yield* CodexAppServerCapabilities;
  const historyPages = yield* CodexHistoryPageAdapter;
  const rendererRegistry = yield* CodexRendererConversationRegistry;
  const conversations = yield* ConversationEntityMap;
  const loads = yield* FiberMap.make<
    string,
    CodexConversationHistoryPageResult,
    CodexConversationHistoryError
  >();
  const runLoad = yield* FiberMap.runtime(loads)();
  const activeKeysByThread = new Map<string, Set<string>>();

  const admit = (
    request: CodexConversationHistoryPageRequest,
  ): Effect.Effect<HistoryPageAdmission, CodexConversationHistoryError> =>
    conversations.runCommand(
      request.threadId,
      Effect.gen(function* () {
        const entity = conversations.current(request.threadId);
        const state = entity?.readCanonicalState() ?? null;
        if (!entity || !state || !entity.readSnapshot()) {
          return yield* historyError("not-loaded", new Error("Conversation is not loaded"));
        }
        if (entity.generation !== request.expectedConversationGeneration) {
          return yield* historyError(
            "stale-generation",
            new Error("Conversation generation changed before admission"),
          );
        }
        const boundaryHandle =
          request.target.kind === "turnBoundary"
            ? readBoundaryHandle(entity, request.target)
            : null;
        const itemCursor =
          request.target.kind === "turnItems"
            ? entity.readHistoryItemPageCursor(
                request.target.items.turnId,
                request.target.items.edge,
              )
            : null;
        if (
          (request.target.kind === "turnBoundary" && boundaryHandle === null) ||
          (request.target.kind === "turnItems" && itemCursor === undefined) ||
          !entity.beginHistoryPageLoad(request)
        ) {
          return yield* historyError(
            "stale-target",
            new Error("History target no longer identifies the resident cursor boundary"),
          );
        }
        return { entity, state, boundaryHandle, itemCursor: itemCursor ?? null };
      }),
    );

  const release = (request: CodexConversationHistoryPageRequest): Effect.Effect<void> =>
    conversations.runCommand(
      request.threadId,
      Effect.sync(() => {
        conversations.current(request.threadId)?.endHistoryPageLoad(request);
      }),
    );

  const mapCommit = (
    result: ReturnType<ConversationEntityState["commitHistoryPage"]>,
  ): Effect.Effect<CodexConversationHistoryPageResult, CodexConversationHistoryError> => {
    if (result.status === "committed") {
      return Effect.succeed({ status: "applied", mutation: result.mutation });
    }
    if (result.status === "staleGeneration") {
      return Effect.fail(historyError("stale-generation", new Error("History generation changed")));
    }
    if (result.status === "staleTarget") {
      return Effect.fail(historyError("stale-target", new Error("History target advanced")));
    }
    return Effect.fail(
      historyError(
        "projection-rejected",
        new Error(result.status === "rejected" ? result.reason : "History commit was rejected"),
      ),
    );
  };

  const commitBoundary = (input: {
    readonly request: CodexConversationHistoryPageRequest;
    readonly admission: HistoryPageAdmission;
    readonly page: CodexHydratedHistoryTurnPage;
  }): Effect.Effect<CodexConversationHistoryPageResult, CodexConversationHistoryError> =>
    conversations.runCommand(
      input.request.threadId,
      Effect.gen(function* () {
        if (input.request.target.kind !== "turnBoundary" || !input.admission.boundaryHandle) {
          return yield* historyError("stale-target", new Error("Boundary admission was lost"));
        }
        const entity = conversations.current(input.request.threadId);
        const latest = entity?.readCanonicalState() ?? null;
        if (!entity || entity !== input.admission.entity || !latest) {
          return yield* historyError(
            "stale-generation",
            new Error("Conversation generation changed during history read"),
          );
        }
        const state = yield* Effect.try({
          try: () =>
            projectCodexConversationOlderTurns({
              current: latest,
              olderTurns: input.page.turns,
              oldestLoadedTurnId: input.admission.boundaryHandle!.oldestLoadedTurnId,
              itemsPaginationByTurnId: input.page.itemsPaginationByTurnId,
            }),
          catch: (cause) => historyError("projection-rejected", cause),
        });
        const target = input.request.target;
        const oldestLoadedTurnId =
          target.boundary.edge === "older"
            ? (input.page.turns[0]?.id ?? input.admission.boundaryHandle.oldestLoadedTurnId)
            : input.admission.boundaryHandle.oldestLoadedTurnId;
        return yield* mapCommit(
          entity.commitHistoryPage({
            request: input.request,
            state,
            turnIds: input.page.turns.map((turn) => turn.id),
            itemsPaginationByTurnId: input.page.itemsPaginationByTurnId,
            itemSegmentsByTurnId: input.page.itemSegmentsByTurnId,
            continuation: continuationForPage({
              boundaryId: target.boundary.boundaryId,
              previous: input.admission.boundaryHandle,
              nextCursor: input.page.nextCursor,
              oldestLoadedTurnId,
            }),
            observedAtMs: Date.now(),
            projectReplica: !rendererRegistry.hasOwner(input.request.threadId),
          }),
        );
      }),
    );

  const commitItems = (input: {
    readonly request: CodexConversationHistoryPageRequest;
    readonly admission: HistoryPageAdmission;
    readonly page: CodexHydratedHistoryItemPage;
  }): Effect.Effect<CodexConversationHistoryPageResult, CodexConversationHistoryError> =>
    conversations.runCommand(
      input.request.threadId,
      Effect.gen(function* () {
        if (input.request.target.kind !== "turnItems") {
          return yield* historyError("stale-target", new Error("Turn-item admission was lost"));
        }
        const target = input.request.target;
        const entity = conversations.current(input.request.threadId);
        const latest = entity?.readCanonicalState() ?? null;
        const previous = entity?.readTurnItemsPagination(target.items.turnId);
        if (!entity || entity !== input.admission.entity || !latest || !previous) {
          return yield* historyError(
            "stale-generation",
            new Error("Conversation generation changed during item read"),
          );
        }
        const projectedPage = yield* Effect.try({
          try: () =>
            projectCodexConversationTurnItemPage({
              current: latest,
              turnId: target.items.turnId,
              items: input.page.items,
              itemsView: "summary",
              observedAtMs: Date.now(),
            }),
          catch: (cause) => historyError("projection-rejected", cause),
        });
        const projectedBytes = cappedApproximateValueBytes(
          projectedPage,
          DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxApproximateBytes,
        );
        const approximateBytes = Math.max(input.page.approximateBytes, projectedBytes);
        if (approximateBytes > DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxApproximateBytes) {
          return yield* historyError(
            "projection-rejected",
            new Error(
              `Projected item page for Turn '${target.items.turnId}' exceeds its byte limit`,
            ),
          );
        }
        return yield* mapCommit(
          entity.commitHistoryPage({
            request: input.request,
            state: latest,
            turnIds: [target.items.turnId],
            itemsPaginationByTurnId: {
              [target.items.turnId]: previous,
            },
            itemPage: {
              direction: target.items.edge,
              segmentId: `page:${target.items.edge}:${target.items.turnId}:${target.items.progressKey}`,
              canonicalItems: projectedPage.canonicalItems,
              rendererItems: projectedPage.rendererItems,
              itemIds: projectedPage.itemIds,
              approximateBytes,
              nextCursor: input.page.nextCursor,
              backwardsCursor: input.page.backwardsCursor,
            },
            observedAtMs: Date.now(),
            projectReplica: !rendererRegistry.hasOwner(input.request.threadId),
          }),
        );
      }),
    );

  const loadPhysical = (
    request: CodexConversationHistoryPageRequest,
  ): Effect.Effect<CodexConversationHistoryPageResult, CodexConversationHistoryError> =>
    Effect.gen(function* () {
      const admission = yield* admit(request);
      const capability = yield* capabilities
        .forThread(request.threadId)
        .pipe(Effect.mapError((cause) => historyError("physical-read", cause)));
      if (!capability.flags.paginatedHistory) {
        return yield* historyError(
          "unsupported",
          new Error("The current app-server generation does not support bounded history"),
        );
      }
      if (request.target.kind === "turnBoundary") {
        if (!admission.boundaryHandle) {
          return yield* historyError("stale-target", new Error("Boundary cursor is unavailable"));
        }
        const page = yield* historyPages
          .loadTurnPage({
            capability,
            threadId: request.threadId,
            cursor: admission.boundaryHandle.cursor,
            initialItemsCursor: null,
            sortDirection: request.target.boundary.edge === "older" ? "desc" : "asc",
            purpose: "older",
          })
          .pipe(Effect.mapError((cause) => historyError("physical-read", cause)));
        const current = yield* capabilities
          .isCurrent(capability)
          .pipe(Effect.mapError((cause) => historyError("physical-read", cause)));
        if (!current) {
          return yield* historyError(
            "stale-generation",
            new Error("App-server generation changed during history read"),
          );
        }
        return yield* commitBoundary({ request, admission, page });
      }
      const page = yield* historyPages
        .loadTurnItemsPage({
          capability,
          threadId: request.threadId,
          turnId: request.target.items.turnId,
          cursor: admission.itemCursor,
          sortDirection: request.target.items.edge === "older" ? "desc" : "asc",
          purpose: "older",
        })
        .pipe(Effect.mapError((cause) => historyError("physical-read", cause)));
      const current = yield* capabilities
        .isCurrent(capability)
        .pipe(Effect.mapError((cause) => historyError("physical-read", cause)));
      if (!current) {
        return yield* historyError(
          "stale-generation",
          new Error("App-server generation changed during item read"),
        );
      }
      return yield* commitItems({ request, admission, page });
    }).pipe(Effect.ensuring(release(request)));

  const loadPage = (
    request: CodexConversationHistoryPageRequest,
  ): Effect.Effect<CodexConversationHistoryPageResult, CodexConversationHistoryError> =>
    Effect.suspend(() => {
      const key = codexConversationHistoryPageRequestKey(request);
      const existing = FiberMap.getUnsafe(loads, key);
      if (Option.isSome(existing)) return Fiber.join(existing.value);
      const keys = activeKeysByThread.get(request.threadId) ?? new Set<string>();
      keys.add(key);
      activeKeysByThread.set(request.threadId, keys);
      const physical = loadPhysical(request).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const active = activeKeysByThread.get(request.threadId);
            active?.delete(key);
            if (active?.size === 0) activeKeysByThread.delete(request.threadId);
          }),
        ),
      );
      return Fiber.join(runLoad(key, physical));
    });

  const clear = (threadId: string): void => {
    const keys = activeKeysByThread.get(threadId);
    activeKeysByThread.delete(threadId);
    for (const key of keys ?? []) runLoad(key, Effect.interrupt);
  };

  yield* Effect.addFinalizer(() => Effect.sync(() => activeKeysByThread.clear()));
  return CodexConversationHistoryRuntime.of({ loadPage, clear });
});
