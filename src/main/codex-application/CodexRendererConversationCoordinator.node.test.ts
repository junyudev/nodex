import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { CodexConversationSnapshot, CodexThreadStreamCheckpoint } from "../../shared/types";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import {
  CodexOwnerNotificationDrainRuntime,
  CodexOwnerNotificationDrainOwnerChanged,
  make as makeNotificationDrain,
} from "./CodexOwnerNotificationDrainRuntime";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { make as makeCoordinator } from "./CodexRendererConversationCoordinator";
import {
  CodexRendererConversationRegistry,
  make as makeRendererRegistry,
} from "./CodexRendererConversationRegistry";
import { CodexRendererOwnerRetention } from "./CodexRendererOwnerRetention";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import {
  ConversationEntityMap,
  live as conversationEntityMapLive,
} from "./internal/ConversationEntityMap";

const build = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const conversationContext = yield* Layer.buildWithScope(conversationEntityMapLive, scope);
  const conversations = Context.get(conversationContext, ConversationEntityMap);
  const registry = yield* makeRendererRegistry().pipe(Effect.provideService(Scope.Scope, scope));
  const notificationDrain = yield* makeNotificationDrain();
  const published: CodexApplicationEvent[] = [];
  const coordinator = yield* makeCoordinator.pipe(
    Effect.provideService(
      CodexApplicationEventHub,
      CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: (event) => published.push(event),
      }),
    ),
    Effect.provideService(CodexOwnerNotificationDrainRuntime, notificationDrain),
    Effect.provideService(
      CodexPendingServerRequestRuntime,
      CodexPendingServerRequestRuntime.of({} as CodexPendingServerRequestRuntime["Service"]),
    ),
    Effect.provideService(CodexRendererConversationRegistry, registry),
    Effect.provideService(
      CodexRendererOwnerRetention,
      CodexRendererOwnerRetention.of({ reconcile: () => Effect.void } as never),
    ),
    Effect.provideService(
      CodexUserInputAutoResolution,
      CodexUserInputAutoResolution.of({} as CodexUserInputAutoResolution["Service"]),
    ),
    Effect.provideService(ConversationEntityMap, conversations),
    Effect.provideService(Scope.Scope, scope),
  );

  return { coordinator, conversations, notificationDrain, published, registry };
});

const seedOwner = (conversations: ConversationEntityMap["Service"], threadId: string) => {
  const snapshot = {
    threadId,
    resumeState: "resumed",
    turns: [],
    requests: [],
  } as unknown as CodexConversationSnapshot;
  conversations.entity(threadId).installSnapshot(snapshot);
};

it.effect(
  "followers receive a current owner snapshot rather than the cached recovery document",
  () =>
    Effect.gen(function* () {
      const { coordinator, conversations, published, registry } = yield* build;
      const threadId = "thread-attach";
      seedOwner(conversations, threadId);
      const adopted = yield* coordinator.adoptRendererOwner({
        conversationId: threadId,
        ownerClientId: "owner",
      });
      const base = adopted.checkpoint!;
      yield* coordinator.handleClientConnected("follower");
      published.length = 0;
      yield* coordinator.setFollowing(threadId, "follower", true);
      assert.isFalse(published.some((event) => event.kind === "rendererThreadStreamRelay"));
      assert.deepEqual(published.at(-1), {
        kind: "rendererThreadStreamControlRelay",
        value: {
          targetClientIds: ["owner"],
          message: {
            type: "threadStreamSnapshotRequested",
            hostId: "default",
            conversationId: threadId,
            ownerClientId: "owner",
            ownerEpoch: base.ownerEpoch,
          },
        },
      });
      const patched = { ...base, revision: base.revision + 1 };
      assert.isTrue(
        coordinator.publishOwnerStateChange("owner", {
          conversationId: threadId,
          baseCheckpoint: base,
          checkpoint: patched,
          change: {
            type: "patches",
            baseRevision: base.revision,
            revision: patched.revision,
            patches: [],
          },
        }).accepted,
      );
      assert.isFalse(published.some((event) => event.kind === "rendererThreadStreamRelay"));
      const current = {
        ...coordinator.readRendererState(threadId).acceptedConversation!,
        title: "Current owner title",
      };
      const checkpoint = { ...patched, revision: patched.revision + 1 };
      const publication = {
        conversationId: threadId,
        baseCheckpoint: patched,
        checkpoint,
        change: {
          type: "snapshot" as const,
          revision: checkpoint.revision,
          conversationState: current,
        },
      };
      assert.isFalse(coordinator.publishOwnerStateChange("intruder", publication).accepted);
      assert.isTrue(coordinator.publishOwnerStateChange("owner", publication).accepted);
      const relays = published.filter((event) => event.kind === "rendererThreadStreamRelay");
      assert.strictEqual(relays.length, 1);
      const relay = relays[0]!;
      assert.deepEqual(relay.value.targetClientIds, ["follower"]);
      assert.isTrue(
        relay.value.message.type === "threadStreamStateChanged" &&
          relay.value.message.change.type === "snapshot",
      );
      if (
        relay.value.message.type !== "threadStreamStateChanged" ||
        relay.value.message.change.type !== "snapshot"
      )
        return;
      assert.deepEqual(relay.value.message.change.conversationState, current);
      // A publication arriving before the follower ACK requires another current owner barrier.
      const newer = { ...checkpoint, revision: checkpoint.revision + 1 };
      assert.isTrue(
        coordinator.publishOwnerStateChange("owner", {
          conversationId: threadId,
          baseCheckpoint: checkpoint,
          checkpoint: newer,
          change: {
            type: "patches",
            baseRevision: checkpoint.revision,
            revision: newer.revision,
            patches: [],
          },
        }).accepted,
      );
      published.length = 0;
      assert.isFalse(
        yield* coordinator.acknowledgeFollowerSnapshotApplied("follower", {
          conversationId: threadId,
          ownerClientId: "owner",
          checkpoint,
        }),
      );
      assert.isFalse(published.some((event) => event.kind === "rendererThreadStreamRelay"));
      assert.isTrue(
        published.some(
          (event) =>
            event.kind === "rendererThreadStreamControlRelay" &&
            event.value.message.type === "threadStreamSnapshotRequested",
        ),
      );
      const catchup = { ...newer, revision: newer.revision + 1 };
      assert.isTrue(
        coordinator.publishOwnerStateChange("owner", {
          conversationId: threadId,
          baseCheckpoint: newer,
          checkpoint: catchup,
          change: { type: "snapshot", revision: catchup.revision, conversationState: current },
        }).accepted,
      );
      assert.deepEqual(registry.getFollowerClientIds(threadId), []);
      assert.isTrue(
        yield* coordinator.acknowledgeFollowerSnapshotApplied("follower", {
          conversationId: threadId,
          ownerClientId: "owner",
          checkpoint: catchup,
        }),
      );
      assert.deepEqual(registry.getFollowerClientIds(threadId), ["follower"]);

      published.length = 0;
      assert.isTrue(
        yield* coordinator.requestStreamResync("follower", {
          conversationId: threadId,
          ownerClientId: "owner",
          observedCheckpoint: checkpoint,
          reason: "revision-gap",
        }),
      );
      assert.isFalse(published.some((event) => event.kind === "rendererThreadStreamRelay"));
      assert.isTrue(
        published.some(
          (event) =>
            event.kind === "rendererThreadStreamControlRelay" &&
            event.value.message.type === "threadStreamSnapshotRequested",
        ),
      );
    }),
);

it.effect("owner transfer preserves the exact document and fences old owner snapshots", () =>
  Effect.gen(function* () {
    const { coordinator, conversations } = yield* build;
    const threadId = "thread-transfer";
    seedOwner(conversations, threadId);
    const adopted = yield* coordinator.adoptRendererOwner({
      conversationId: threadId,
      ownerClientId: "old-owner",
    });
    const base = adopted.checkpoint!;
    const exact = {
      ...coordinator.readRendererState(threadId).acceptedConversation!,
      historyMutationRevision: 97,
    };
    const checkpoint: CodexThreadStreamCheckpoint = { ...base, revision: base.revision + 1 };
    assert.isTrue(
      coordinator.publishOwnerStateChange("old-owner", {
        conversationId: threadId,
        baseCheckpoint: base,
        checkpoint,
        change: { type: "snapshot", revision: checkpoint.revision, conversationState: exact },
      }).accepted,
    );
    yield* coordinator.setOwner(threadId, "new-owner");
    const transferred = coordinator.readRendererState(threadId);
    assert.deepEqual(transferred.acceptedConversation, exact);
    assert.strictEqual(transferred.checkpoint?.revision, checkpoint.revision);
    assert.notStrictEqual(transferred.checkpoint?.ownerEpoch, checkpoint.ownerEpoch);
    assert.isFalse(
      coordinator.publishOwnerStateChange("new-owner", {
        conversationId: threadId,
        baseCheckpoint: checkpoint,
        checkpoint: { ...checkpoint, revision: checkpoint.revision + 1 },
        change: { type: "snapshot", revision: checkpoint.revision + 1, conversationState: exact },
      }).accepted,
    );
  }),
);

it.effect("adopts a canonical snapshot as the first accepted renderer replica", () =>
  Effect.gen(function* () {
    const { coordinator, conversations, published } = yield* build;
    const snapshot = {
      threadId: "thread-fresh",
      resumeState: "resumed",
      turns: [],
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
    } as unknown as CodexConversationSnapshot;
    conversations.entity(snapshot.threadId).installSnapshot(snapshot);
    const result = yield* coordinator.adoptRendererOwner({
      conversationId: snapshot.threadId,
      ownerClientId: "renderer-fresh",
    });

    assert.strictEqual(result.ownerClientId, "renderer-fresh");
    assert.isNotNull(result.checkpoint);
    assert.deepEqual(coordinator.readRendererState(snapshot.threadId).acceptedConversation, {
      ...snapshot,
      conversationEntityGeneration: 1,
      historyMutationRevision: 0,
    });
    coordinator.resetTransport([snapshot.threadId, snapshot.threadId]);
    assert.deepEqual(published.at(-1), {
      kind: "rendererThreadStreamControlRelay",
      value: {
        targetClientIds: ["renderer-fresh"],
        message: {
          type: "threadStreamTransportReset",
          hostId: "default",
          conversationIds: [snapshot.threadId],
        },
      },
    });
  }),
);

it.effect("dormant notifications never create acknowledgment work for an absent owner", () =>
  Effect.gen(function* () {
    const { coordinator, notificationDrain, published } = yield* build;
    assert.isFalse(
      coordinator.forwardNotification({
        method: "thread/status/changed",
        params: { threadId: "thread-dormant", status: { type: "idle" } },
      }),
    );
    const waiting = yield* Effect.forkChild(notificationDrain.awaitCurrent("thread-dormant"), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    assert.strictEqual(waiting.pollUnsafe()?._tag, "Success");
    assert.deepEqual(published, []);
  }),
);

it.effect("owner IPC reset invalidates pending drains and fences late ACKs after reconnect", () =>
  Effect.gen(function* () {
    const { coordinator, notificationDrain, registry } = yield* build;
    const threadId = "thread-reconnect";
    const clientId = "renderer-reconnect";
    const notification = {
      method: "thread/status/changed",
      params: { threadId, status: { type: "idle" } },
    } as const;
    registry.setOwner(threadId, clientId);
    yield* coordinator.handleClientConnected(clientId);
    assert.isTrue(coordinator.forwardNotification(notification));
    const waiting = yield* Effect.forkChild(notificationDrain.awaitCurrent(threadId), {
      startImmediately: true,
    });
    yield* coordinator.handleClientDeliveryFailure([clientId]);
    yield* Effect.yieldNow;
    const exit = waiting.pollUnsafe();
    assert.isDefined(exit);
    assert.isTrue(exit && Exit.isFailure(exit));
    if (!exit || !Exit.isFailure(exit)) return;
    assert.instanceOf(Cause.squash(exit.cause), CodexOwnerNotificationDrainOwnerChanged);
    assert.isFalse(coordinator.forwardNotification(notification));

    // The reconnecting window keeps its identity, but old deliveries cannot ACK new work.
    registry.setOwner(threadId, clientId);
    yield* coordinator.handleClientConnected(clientId);
    assert.isTrue(coordinator.forwardNotification(notification));
    const current = yield* Effect.forkChild(notificationDrain.awaitCurrent(threadId), {
      startImmediately: true,
    });
    assert.isFalse(
      yield* coordinator.acknowledgeOwnerNotification(clientId, {
        conversationId: threadId,
        sequence: 1,
      }),
    );
    assert.isUndefined(current.pollUnsafe());
    assert.isTrue(
      yield* coordinator.acknowledgeOwnerNotification(clientId, {
        conversationId: threadId,
        sequence: 2,
      }),
    );
    yield* Fiber.join(current);
  }),
);

it.effect(
  "recovery-only snapshots preserve revision and cannot bypass a pending follower barrier",
  () =>
    Effect.gen(function* () {
      const { coordinator, conversations, published } = yield* build;
      const conversationId = "thread-recovery-only";
      seedOwner(conversations, conversationId);
      const adopted = yield* coordinator.adoptRendererOwner({
        conversationId,
        ownerClientId: "owner",
      });
      const checkpoint = adopted.checkpoint!;
      const latest = {
        ...conversations.entity(conversationId).readSnapshot()!,
        threadName: "Latest owner history",
      };
      const input = {
        conversationId,
        recoveryOnly: true as const,
        baseCheckpoint: checkpoint,
        checkpoint,
        change: {
          type: "snapshot" as const,
          revision: checkpoint.revision,
          conversationState: latest,
        },
      };
      published.length = 0;
      assert.deepEqual(coordinator.publishOwnerStateChange("owner", input), {
        accepted: true,
        checkpoint,
      });
      assert.strictEqual(
        conversations.entity(conversationId).read().acceptedReplica?.conversation.threadName,
        latest.threadName,
      );
      assert.strictEqual(published.length, 0);
      assert.strictEqual(coordinator.publishOwnerStateChange("stranger", input).accepted, false);
      yield* coordinator.handleClientConnected("follower");
      yield* coordinator.setFollowing(conversationId, "follower", true);
      const rejected = coordinator.publishOwnerStateChange("owner", input);
      assert.isFalse(rejected.accepted);
      if (!rejected.accepted) assert.strictEqual(rejected.reason, "followers-present");
    }),
);
