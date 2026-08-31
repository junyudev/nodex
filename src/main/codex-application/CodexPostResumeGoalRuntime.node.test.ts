import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { CodexConversationSnapshot } from "../../shared/types";
import { CodexActiveGoalContinuation } from "./CodexActiveGoalContinuation";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";
import { CodexConversationHistoryRuntime } from "./CodexConversationHistoryRuntime";
import { make } from "./CodexPostResumeGoalRuntime";
import { CodexThreadGoalRuntime, type CodexThreadGoalLoadResult } from "./CodexThreadGoalRuntime";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

const threadId = "thread-goal";

const goal: ThreadGoal = {
  threadId,
  objective: "Finish the final Effect cut-over",
  status: "active",
  tokenBudget: null,
  tokensUsed: 1,
  timeUsedSeconds: 2,
  createdAt: 1,
  updatedAt: 2,
};

const conversation = (): CodexConversationSnapshot =>
  ({
    threadId,
    resumeState: "resumed",
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
  }) as unknown as CodexConversationSnapshot;

const makeConversations = (revision = 1) => {
  const aggregates = makeConversationEntityStateRegistry();
  const aggregate = aggregates.acquire(threadId);
  aggregate.acceptReplica({ conversation: conversation(), revision, ownerEpoch: 0 });
  return {
    aggregate,
    service: ConversationEntityMap.of({
      entity: aggregates.acquire,
      current: aggregates.current,
    } as unknown as ConversationEntityMap["Service"]),
  };
};

const makeRuntime = (input: {
  readonly conversations: ConversationEntityMap["Service"];
  readonly load: (threadId: string) => Effect.Effect<CodexThreadGoalLoadResult>;
  readonly onContinuation?: (threadId: string) => void;
  readonly onContinuationClear?: (threadId: string) => void;
  readonly onHistoryClear?: (threadId: string) => void;
}) =>
  make.pipe(
    Effect.provideService(
      CodexThreadGoalRuntime,
      CodexThreadGoalRuntime.of({
        load: input.load,
      } as unknown as CodexThreadGoalRuntime["Service"]),
    ),
    Effect.provideService(
      CodexActiveGoalContinuation,
      CodexActiveGoalContinuation.of({
        request: (id) => Effect.sync(() => input.onContinuation?.(id)),
        clear: (id) => Effect.sync(() => input.onContinuationClear?.(id)),
      }),
    ),
    Effect.provideService(
      CodexConversationHistoryRuntime,
      CodexConversationHistoryRuntime.of({
        loadPage: () => Effect.die("unused"),
        clear: (id) => input.onHistoryClear?.(id),
      }),
    ),
    Effect.provideService(ConversationEntityMap, input.conversations),
  );

const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Post-resume goal test did not settle: ${label}`));
  });

it.effect("shares one load while the aggregate enforces each caller's revision fence", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<CodexThreadGoalLoadResult>();
    const conversations = makeConversations();
    let loads = 0;
    let continuations = 0;
    const runtime = yield* makeRuntime({
      conversations: conversations.service,
      load: () =>
        Effect.sync(() => {
          loads += 1;
        }).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(release)),
        ),
      onContinuation: () => {
        continuations += 1;
      },
    });

    const stale = yield* runtime.hydrate(threadId, 1).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    conversations.aggregate.acceptReplica({
      conversation: conversation(),
      revision: 2,
      ownerEpoch: 0,
    });
    const current = yield* runtime.hydrate(threadId, 2).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, { ok: true, goal });
    yield* Fiber.join(stale);
    yield* Fiber.join(current);

    assert.strictEqual(loads, 1);
    assert.strictEqual(conversations.aggregate.readSnapshot()?.threadGoal, goal);
    assert.strictEqual(
      conversations.aggregate.read().acceptedReplica?.conversation.threadGoal,
      goal,
    );
    assert.strictEqual(conversations.aggregate.read().revision, 2);
    assert.strictEqual(continuations, 1);
  }),
);

it.effect("coalesces background demand to the latest revision without draining history", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<CodexThreadGoalLoadResult>();
    const conversations = makeConversations();
    let continuations = 0;
    const runtime = yield* makeRuntime({
      conversations: conversations.service,
      load: () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      onContinuation: () => {
        continuations += 1;
      },
    });

    runtime.request(threadId, 1);
    yield* Deferred.await(started);
    conversations.aggregate.acceptReplica({
      conversation: conversation(),
      revision: 2,
      ownerEpoch: 0,
    });
    runtime.request(threadId, 2);
    yield* Deferred.succeed(release, { ok: true, goal });
    yield* waitUntil("background flow", () => continuations === 2);

    assert.strictEqual(conversations.aggregate.readSnapshot()?.threadGoal, goal);
    assert.strictEqual(conversations.aggregate.read().revision, 2);
    assert.strictEqual(continuations, 2);
  }),
);

it.effect("Main Scope close interrupts the shared physical load", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const conversations = makeConversations();
    const runtime = yield* makeRuntime({
      conversations: conversations.service,
      load: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
    }).pipe(Effect.provideService(Scope.Scope, ownerScope));

    runtime.request(threadId, 1);
    yield* Deferred.await(started);
    yield* Scope.close(ownerScope, Exit.void);
    yield* Deferred.await(interrupted);
  }),
);
