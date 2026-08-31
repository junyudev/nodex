import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { CodexConversationSnapshot } from "../../shared/types";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
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

it.effect("adopts a canonical snapshot as the first accepted renderer replica", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const conversationContext = yield* Layer.buildWithScope(conversationEntityMapLive, scope);
    const conversations = Context.get(conversationContext, ConversationEntityMap);
    const registry = yield* makeRendererRegistry().pipe(Effect.provideService(Scope.Scope, scope));
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
    const published: CodexApplicationEvent[] = [];
    const coordinator = yield* makeCoordinator.pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: (event) => published.push(event),
        }),
      ),
      Effect.provideService(
        CodexOwnerNotificationDrainRuntime,
        CodexOwnerNotificationDrainRuntime.of({ resetOwner: () => undefined } as never),
      ),
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
    yield* Scope.close(scope, Exit.void);
  }),
);
