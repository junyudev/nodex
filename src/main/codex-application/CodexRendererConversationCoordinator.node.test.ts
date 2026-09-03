import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { CodexConversationSnapshot } from "../../shared/types";
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
