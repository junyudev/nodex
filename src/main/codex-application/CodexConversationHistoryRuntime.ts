import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { CodexConversationSnapshot } from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { projectCodexConversationOlderTurns } from "./CodexConversationHistoryProjection";
import { CodexRendererConversationRegistry } from "./CodexRendererConversationRegistry";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export interface CodexConversationHistoryLoadInput {
  readonly threadId: string;
  readonly loadCompleteHistory: boolean;
  readonly broadcastResult: boolean;
}

export class CodexConversationHistoryError extends Data.TaggedError(
  "CodexConversationHistoryError",
)<{
  readonly cause: unknown;
}> {}

export class CodexConversationHistoryRuntime extends Context.Service<
  CodexConversationHistoryRuntime,
  {
    readonly loadPage: (
      threadId: string,
    ) => Effect.Effect<CodexConversationSnapshot | null, CodexConversationHistoryError>;
    readonly loadComplete: (
      threadId: string,
      broadcastResult: boolean,
    ) => Effect.Effect<CodexConversationSnapshot | null, CodexConversationHistoryError>;
    readonly clear: (threadId: string) => void;
  }
>()("nodex/main/codex-application/CodexConversationHistoryRuntime") {}

const THREAD_TURNS_PAGE_SIZE = 5;

type GatewayHistoryTurn = ClientRequestResponsesByMethod["thread/turns/list"]["data"][number];

const normalizeGatewayHistoryTurn = (turn: GatewayHistoryTurn): Turn =>
  ({
    ...turn,
    items: [...turn.items],
    itemsView: turn.itemsView ?? "full",
    error: turn.error ?? null,
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    durationMs: turn.durationMs ?? null,
  }) as Turn;

/** Final history capability: gateway pages commit through one aggregate revision fence. */
export const make: Effect.Effect<
  CodexConversationHistoryRuntime["Service"],
  never,
  CodexGateway | CodexRendererConversationRegistry | ConversationEntityMap | Scope.Scope
> = Effect.gen(function* () {
  const gateway = yield* CodexGateway;
  const rendererRegistry = yield* CodexRendererConversationRegistry;
  const conversations = yield* ConversationEntityMap;
  const loads = yield* FiberMap.make<string, void, CodexConversationHistoryError>();
  const runLoad = yield* FiberMap.runtime(loads)();
  const active = new Map<
    string,
    { readonly token: object; readonly loadCompleteHistory: boolean }
  >();

  const loadPhysical = (
    input: CodexConversationHistoryLoadInput,
  ): Effect.Effect<void, CodexConversationHistoryError> =>
    Effect.gen(function* () {
      const aggregate = conversations.current(input.threadId);
      const snapshot = aggregate?.readSnapshot() ?? null;
      if (!aggregate || !snapshot || !aggregate.readCanonicalState()) return;
      const pagination = aggregate.readTurnPagination();
      if (pagination.hasLoadedOldest || pagination.olderCursor === null) return;
      const fence = aggregate.beginHistoryLoad(snapshot.turns.length);
      if (!fence) return;

      const pages: ClientRequestResponsesByMethod["thread/turns/list"][] = [];
      let cursor: string | null = fence.olderCursor;
      const operation = Effect.gen(function* () {
        while (cursor !== null) {
          const requestedCursor: string = cursor;
          const page = yield* gateway
            .requestForThread(input.threadId, "thread/turns/list", {
              threadId: input.threadId,
              cursor: requestedCursor,
              limit: THREAD_TURNS_PAGE_SIZE,
              sortDirection: "desc",
              itemsView: "full",
            })
            .pipe(Effect.mapError((cause) => new CodexConversationHistoryError({ cause })));
          if (!aggregate.isHistoryLoadCurrent(fence)) return;
          if (page.nextCursor === requestedCursor) {
            return yield* Effect.fail(
              new CodexConversationHistoryError({
                cause: new Error("Codex older-turn pagination did not advance its cursor"),
              }),
            );
          }
          pages.push(page);
          cursor = page.nextCursor ?? null;
          if (!input.loadCompleteHistory) break;
        }

        const lastPage = pages.at(-1);
        if (!lastPage) {
          aggregate.failHistoryLoad(fence);
          return;
        }
        const current = aggregate.readCanonicalState();
        if (!current || !aggregate.isHistoryLoadCurrent(fence)) return;
        const olderTurns = pages
          .map((page) => [...page.data].reverse().map(normalizeGatewayHistoryTurn))
          .reverse()
          .flat();
        const state = yield* Effect.try({
          try: () =>
            projectCodexConversationOlderTurns({
              current,
              olderTurns,
              oldestLoadedTurnId: fence.oldestLoadedTurnId,
            }),
          catch: (cause) => new CodexConversationHistoryError({ cause }),
        });
        const oldestLoadedTurnId = olderTurns[0]?.id ?? fence.oldestLoadedTurnId;
        aggregate.commitHistoryProjection({
          fence,
          state,
          pagination: {
            olderCursor: lastPage.nextCursor ?? null,
            backwardsCursor: lastPage.backwardsCursor ?? null,
            oldestLoadedTurnId,
            isLoadingOlder: false,
            hasLoadedOldest: lastPage.nextCursor == null,
            loadedTurnCount: state.turns.length,
            itemsView: "full",
          },
          loadedTurnCount: state.turns.length,
          observedAtMs: Date.now(),
          projectReplica: input.broadcastResult && !rendererRegistry.hasOwner(input.threadId),
        });
      });
      yield* operation.pipe(
        Effect.tapError(() => Effect.sync(() => aggregate.failHistoryLoad(fence))),
      );
    });

  const load = (
    input: CodexConversationHistoryLoadInput,
  ): Effect.Effect<void, CodexConversationHistoryError> =>
    Effect.suspend(() => {
      const existing = FiberMap.getUnsafe(loads, input.threadId);
      if (Option.isSome(existing)) {
        const existingLoadsCompleteHistory =
          active.get(input.threadId)?.loadCompleteHistory === true;
        return Fiber.join(existing.value).pipe(
          Effect.andThen(
            input.loadCompleteHistory && !existingLoadsCompleteHistory ? load(input) : Effect.void,
          ),
        );
      }

      const token = {};
      active.set(input.threadId, {
        token,
        loadCompleteHistory: input.loadCompleteHistory,
      });
      const physical = loadPhysical(input).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (active.get(input.threadId)?.token === token) active.delete(input.threadId);
          }),
        ),
      );
      return Fiber.join(runLoad(input.threadId, physical));
    });

  const snapshot = (threadId: string): CodexConversationSnapshot | null =>
    conversations.current(threadId)?.readSnapshot() ?? null;

  const clear = (threadId: string): void => {
    active.delete(threadId);
    runLoad(threadId, Effect.void);
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      active.clear();
    }),
  );

  return CodexConversationHistoryRuntime.of({
    loadPage: (threadId) =>
      load({ threadId, loadCompleteHistory: false, broadcastResult: true }).pipe(
        Effect.andThen(Effect.sync(() => snapshot(threadId))),
      ),
    loadComplete: (threadId, broadcastResult) =>
      load({ threadId, loadCompleteHistory: true, broadcastResult }).pipe(
        Effect.andThen(Effect.sync(() => snapshot(threadId))),
      ),
    clear,
  });
});
