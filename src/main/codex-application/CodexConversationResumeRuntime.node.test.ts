import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { CodexConversationSnapshot } from "../../shared/types";
import { CodexApplicationProtocol } from "./CodexApplicationProtocol";
import { CodexConversationHistoryRuntime } from "./CodexConversationHistoryRuntime";
import { CodexConversationRelationships } from "./CodexConversationRelationships";
import { CodexFreshThreadLaunchRuntime } from "./CodexFreshThreadLaunchRuntime";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
import { CodexPostResumeGoalRuntime } from "./CodexPostResumeGoalRuntime";
import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { make } from "./CodexConversationResumeRuntime";
import { CodexRendererConversationCoordinator } from "./CodexRendererConversationCoordinator";
import {
  CodexRendererConversationRegistry,
  makeCodexRendererConversationRegistryState,
} from "./CodexRendererConversationRegistry";
import {
  CodexThreadDirectory,
  type CodexThreadDirectoryEntry,
  type CodexThreadDirectoryFidelity,
} from "./CodexThreadDirectory";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";

const threadId = "thread-resume";
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

const entry = (
  snapshot: CodexConversationSnapshot | null,
  fidelity: CodexThreadDirectoryFidelity,
): CodexThreadDirectoryEntry =>
  ({
    fidelity,
    durable: { threadId, archived: false } as CodexThreadDirectoryEntry["durable"],
    summary: { threadId } as CodexThreadDirectoryEntry["summary"],
    canonical: null,
    snapshot,
  }) as CodexThreadDirectoryEntry;

const emptyQueueProjection = () => ({
  status: "ready" as const,
  ledgerRevision: 0,
  projectionRevision: 0,
  entries: [],
  inFlightFollowUpId: null,
  editingFollowUpId: null,
  error: null,
});

const build = Effect.fn("CodexConversationResumeRuntimeTest.build")(function* (
  scope: Scope.Scope,
  resolve: CodexThreadDirectory["Service"]["resolve"],
  relationships: CodexConversationRelationships["Service"] = CodexConversationRelationships.of({
    refresh: () => Effect.succeed([]),
  }),
  readQueue: CodexQueuedFollowUps["Service"]["read"] = () => Effect.succeed(emptyQueueProjection()),
) {
  const context = yield* Layer.buildWithScope(conversationRuntimeMapLive, scope);
  const conversations = Context.get(context, ConversationEntityMap);
  const registry = makeCodexRendererConversationRegistryState();
  const buffers = new Set<string>();
  const directory = CodexThreadDirectory.of({ resolve } as CodexThreadDirectory["Service"]);
  const protocol = CodexApplicationProtocol.of({
    interpret: () => Effect.void,
    observe: () => Effect.void,
    beginResume: (id) => {
      if (buffers.has(id)) return false;
      buffers.add(id);
      return true;
    },
    hasResume: (id) => buffers.has(id),
    releaseResume: (id) => Effect.sync(() => void buffers.delete(id)),
    discardResume: (id) => Effect.sync(() => void buffers.delete(id)),
    clearConversationBuffer: () => Effect.void,
    releaseThreadStart: () => Effect.void,
  });
  const coordinator = CodexRendererConversationCoordinator.of({
    readRendererState: (id: string) => {
      const state = conversations.current(id)?.read();
      return {
        acceptedConversation: state?.acceptedReplica?.conversation ?? null,
        checkpoint: state?.acceptedReplica?.checkpoint ?? null,
        ownerClientId: registry.getOwnerClientId(id),
        resumeState: state?.resumeState ?? null,
        revision: state?.revision ?? 0,
      };
    },
    adoptRendererOwner: (
      input: Parameters<CodexRendererConversationCoordinator["Service"]["adoptRendererOwner"]>[0],
    ) =>
      Effect.sync(() => {
        const owner = registry.setOwner(input.conversationId, input.ownerClientId);
        if (!owner) return { checkpoint: null, ownerClientId: null, revision: 0 };
        const aggregate = conversations.entity(input.conversationId);
        aggregate.setStreamRole("owner");
        if (!aggregate.read().acceptedReplica) {
          const conversation = aggregate.readSnapshot();
          if (!conversation) return { checkpoint: null, ownerClientId: null, revision: 0 };
          aggregate.acceptReplica({
            conversation,
            revision: aggregate.read().revision,
            ownerEpoch: owner.ownerEpoch,
          });
        }
        const state = aggregate.read();
        return {
          checkpoint: state.acceptedReplica?.checkpoint ?? null,
          ownerClientId: registry.getOwnerClientId(input.conversationId),
          revision: state.revision,
        };
      }),
    reconcileOwnership: () => undefined,
  } as unknown as CodexRendererConversationCoordinator["Service"]);
  const queuedFollowUps = CodexQueuedFollowUps.of({
    read: readQueue,
    list: () => [],
    enqueue: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    replace: () => Effect.die("unused"),
    reorder: () => Effect.die("unused"),
    resumeInterrupted: () => Effect.die("unused"),
    resolveAfterFreshStart: () => Effect.die("unused"),
    requestDispatch: () => Effect.void,
    sendNow: () => Effect.die("unused"),
    acceptTerminalOutcomeInCurrentLane: () => Effect.die("unused"),
    closeThread: () => Effect.void,
  });
  const runtime = yield* make.pipe(
    Effect.provideService(CodexApplicationProtocol, protocol),
    Effect.provideService(
      CodexConversationHistoryRuntime,
      CodexConversationHistoryRuntime.of({
        loadPage: () => Effect.succeed(null),
        loadComplete: () => Effect.succeed(null),
        clear: () => undefined,
      }),
    ),
    Effect.provideService(CodexConversationRelationships, relationships),
    Effect.provideService(
      CodexFreshThreadLaunchRuntime,
      CodexFreshThreadLaunchRuntime.of({
        register: () => undefined,
        reservation: () => null,
        adopt: () => Effect.die("unused"),
        start: () => Effect.die("unused"),
        releaseRenderer: () => undefined,
        clear: () => undefined,
      }),
    ),
    Effect.provideService(
      CodexOwnerNotificationDrainRuntime,
      CodexOwnerNotificationDrainRuntime.of({
        next: () => 1,
        ack: () => undefined,
        awaitCurrent: () => Effect.void,
        resetOwner: () => undefined,
        release: () => undefined,
        clear: () => undefined,
      }),
    ),
    Effect.provideService(
      CodexPostResumeGoalRuntime,
      CodexPostResumeGoalRuntime.of({
        hydrate: () => Effect.void,
        request: () => undefined,
        defer: () => undefined,
        release: () => false,
        clear: () => undefined,
      }),
    ),
    Effect.provideService(CodexQueuedFollowUps, queuedFollowUps),
    Effect.provideService(CodexRendererConversationCoordinator, coordinator),
    Effect.provideService(CodexRendererConversationRegistry, registry),
    Effect.provideService(CodexThreadDirectory, directory),
    Effect.provideService(ConversationEntityMap, conversations),
    Effect.provideService(Scope.Scope, scope),
  );
  return { conversations, runtime };
});

it.effect("coalesces identical canonical resume demand", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const release = yield* Deferred.make<void>();
    let physicalRuns = 0;
    const harness = yield* build(scope, ({ fidelity }) => {
      if (fidelity === "durable") return Effect.succeed(null);
      physicalRuns += 1;
      return Deferred.await(release).pipe(Effect.as(null));
    });
    const first = yield* harness.runtime.resume({ threadId }).pipe(Effect.forkChild);
    const second = yield* harness.runtime.resume({ threadId }).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.strictEqual(physicalRuns, 1);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("serializes renderer adoption so a racing client becomes a follower", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const snapshot = conversation();
    const harness = yield* build(scope, ({ fidelity }) =>
      Effect.succeed(entry(snapshot, fidelity)),
    );
    harness.conversations
      .entity(threadId)
      .acceptReplica({ conversation: snapshot, revision: 1, ownerEpoch: 0 });
    const first = yield* harness.runtime
      .resumeForRenderer(threadId, "owner-a")
      .pipe(Effect.forkChild);
    const second = yield* harness.runtime
      .resumeForRenderer(threadId, "owner-b")
      .pipe(Effect.forkChild);
    const owner = yield* Fiber.join(first);
    const follower = yield* Fiber.join(second);
    assert.strictEqual(owner?.role, "owner");
    assert.strictEqual(follower?.role, "follower");
    if (follower?.role === "follower") assert.strictEqual(follower.ownerClientId, "owner-a");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("hydrates queued follow-ups into the recovery replica before renderer adoption", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const targets: Array<string | undefined> = [];
    const snapshot = conversation();
    const harness = yield* build(
      scope,
      ({ fidelity }) => Effect.succeed(entry(snapshot, fidelity)),
      undefined,
      (_threadId, options) =>
        Effect.sync(() => {
          targets.push(options?.projectionTarget);
          return emptyQueueProjection();
        }),
    );
    harness.conversations
      .entity(threadId)
      .acceptReplica({ conversation: snapshot, revision: 1, ownerEpoch: 0 });

    const resumed = yield* harness.runtime.resumeForRenderer(threadId, "owner-a");

    assert.strictEqual(resumed?.role, "owner");
    assert.deepEqual(targets, ["replica"]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("returns a hydrated snapshot when relationship projection fails", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const snapshot = conversation();
    const harness = yield* build(
      scope,
      ({ fidelity }) => Effect.succeed(entry(snapshot, fidelity)),
      CodexConversationRelationships.of({ refresh: () => Effect.die("projection unavailable") }),
    );

    assert.strictEqual((yield* harness.runtime.snapshot(threadId))?.threadId, threadId);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("interrupts physical resume work when the owning Scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const started = yield* Deferred.make<void>();
    const harness = yield* build(scope, ({ fidelity }) =>
      fidelity === "durable"
        ? Effect.succeed(null)
        : Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const fiber = yield* harness.runtime.resume({ threadId }).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual((yield* Fiber.await(fiber))._tag, "Failure");
  }),
);

it.effect("seeds renderer adoption from replacement-generation hydration", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const stale = { ...conversation(), threadPreview: "stale" };
    const fresh = { ...conversation(), threadPreview: "fresh" };
    let installFreshSnapshot = () => {};
    const harness = yield* build(scope, ({ fidelity }) => {
      if (fidelity === "live") installFreshSnapshot();
      return Effect.succeed(entry(fidelity === "live" ? fresh : stale, fidelity));
    });
    const aggregate = harness.conversations.entity(threadId);
    installFreshSnapshot = () => aggregate.installSnapshot(fresh);
    aggregate.installSnapshot(stale);
    aggregate.acceptReplica({ conversation: stale, revision: 4, ownerEpoch: 1 });

    const initial = yield* harness.runtime.resumeForRenderer(threadId, "owner-a");
    assert.strictEqual(initial?.role, "owner");
    assert.strictEqual(initial?.conversation.threadPreview, "stale");

    harness.conversations.markAllNeedsResume();
    const replacement = yield* harness.runtime.resumeForRenderer(threadId, "owner-a");
    assert.strictEqual(replacement?.role, "owner");
    assert.strictEqual(replacement?.conversation.threadPreview, "fresh");
    assert.strictEqual(
      harness.conversations.current(threadId)?.read().acceptedReplica?.conversation.threadPreview,
      "fresh",
    );
    yield* Scope.close(scope, Exit.void);
  }),
);
