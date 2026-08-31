import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { CodexActiveGoalContinuation } from "./CodexActiveGoalContinuation";
import { CodexConversationHistoryRuntime } from "./CodexConversationHistoryRuntime";
import { CodexThreadGoalRuntime, type CodexThreadGoalLoadResult } from "./CodexThreadGoalRuntime";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export class CodexPostResumeGoalRuntime extends Context.Service<
  CodexPostResumeGoalRuntime,
  {
    readonly hydrate: (threadId: string, expectedRevision: number) => Effect.Effect<void>;
    readonly request: (threadId: string, expectedRevision: number) => void;
    readonly defer: (threadId: string) => void;
    readonly release: (threadId: string, expectedRevision: number) => boolean;
    readonly clear: (threadId: string) => void;
  }
>()("nodex/main/codex-application/CodexPostResumeGoalRuntime") {}

export const make: Effect.Effect<
  CodexPostResumeGoalRuntime["Service"],
  never,
  | CodexActiveGoalContinuation
  | CodexConversationHistoryRuntime
  | CodexThreadGoalRuntime
  | ConversationEntityMap
  | Scope.Scope
> = Effect.gen(function* () {
  const activeGoalContinuation = yield* CodexActiveGoalContinuation;
  const conversationHistory = yield* CodexConversationHistoryRuntime;
  const threadGoals = yield* CodexThreadGoalRuntime;
  const conversations = yield* ConversationEntityMap;
  const loads = yield* FiberMap.make<string, CodexThreadGoalLoadResult, never>();
  const requests = yield* FiberMap.make<string, void, never>();
  const runLoad = yield* FiberMap.runtime(loads)();
  const runRequest = yield* FiberMap.runtime(requests)();
  const deferred = new Set<string>();
  const latestRequest = new Map<
    string,
    { readonly generation: number; readonly expectedRevision: number }
  >();

  const load = (threadId: string): Effect.Effect<CodexThreadGoalLoadResult> =>
    Effect.suspend(() => {
      const existing = FiberMap.getUnsafe(loads, threadId);
      if (Option.isSome(existing)) return Fiber.join(existing.value);

      const fiber = runLoad(threadId, threadGoals.load(threadId));
      return Fiber.join(fiber);
    });

  const commit = (threadId: string, expectedRevision: number, result: CodexThreadGoalLoadResult) =>
    result.ok &&
    conversations
      .current(threadId)
      ?.commitPostResumeGoalHydration({ expectedRevision, goal: result.goal }) === true;

  const hydrate = Effect.fn("CodexPostResumeGoalRuntime.hydrate")(function* (
    threadId: string,
    expectedRevision: number,
  ) {
    const result = yield* load(threadId);
    if (!commit(threadId, expectedRevision, result)) return;
    yield* activeGoalContinuation.request(threadId);
  });

  const runRequestedFlow = (threadId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* activeGoalContinuation.request(threadId);
      const result = yield* load(threadId);
      for (;;) {
        const requested = latestRequest.get(threadId);
        if (!requested) return;
        if (commit(threadId, requested.expectedRevision, result)) {
          yield* activeGoalContinuation.request(threadId);
        }
        if (latestRequest.get(threadId)?.generation !== requested.generation) continue;
        latestRequest.delete(threadId);
        return;
      }
    });

  const request = (threadId: string, expectedRevision: number): void => {
    const generation = (latestRequest.get(threadId)?.generation ?? 0) + 1;
    latestRequest.set(threadId, { generation, expectedRevision });
    if (FiberMap.hasUnsafe(requests, threadId)) return;
    runRequest(threadId, runRequestedFlow(threadId));
  };

  const clear = (threadId: string): void => {
    deferred.delete(threadId);
    latestRequest.delete(threadId);
    runRequest(threadId, activeGoalContinuation.clear(threadId));
    runLoad(threadId, Effect.succeed({ ok: false, goal: null }));
    conversationHistory.clear(threadId);
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      deferred.clear();
      latestRequest.clear();
    }),
  );

  return CodexPostResumeGoalRuntime.of({
    hydrate,
    request,
    defer: (threadId) => {
      deferred.add(threadId);
    },
    release: (threadId, expectedRevision) => {
      if (!deferred.delete(threadId)) return false;
      request(threadId, expectedRevision);
      return true;
    },
    clear,
  });
});
