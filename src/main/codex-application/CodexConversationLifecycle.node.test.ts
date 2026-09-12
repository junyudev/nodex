import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { CodexConversationSnapshot } from "../../shared/types";
import { BrowserUseRuntime, BrowserUseRuntimeError } from "../host-runtime/BrowserUseRuntime";
import { make as makeCodexConversationLifecycle } from "./CodexConversationLifecycle";
import { CodexConversationDeltaBufferRuntime } from "./CodexConversationDeltaBufferRuntime";
import { CodexManualCompactionRuntime } from "./CodexManualCompactionRuntime";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import {
  CodexRendererPresentationRegistry,
  make as makePresentationRegistry,
} from "./CodexRendererPresentationRegistry";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";

const snapshot = (threadId: string): CodexConversationSnapshot =>
  ({
    threadId,
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 1,
      projectionRevision: 1,
      entries: [
        {
          threadId,
          followUpId: "follow-up-1",
          prompt: "ship",
        },
      ],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    requests: [],
    resumeState: "resumed",
  }) as unknown as CodexConversationSnapshot;

it.effect("retires every conversation resource from inside its current causal lane", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(conversationRuntimeMapLive, ownerScope);
    const conversations = Context.get(context, ConversationEntityMap);
    const threadId = "thread-a";
    const reason = new Error("thread deleted");
    const calls: string[] = [];
    let rejectedReason: unknown;

    const pending = CodexPendingServerRequestRuntime.of({
      rejectDispatchedDynamicForThread: (candidate: string, candidateReason: unknown) => {
        calls.push(`pending-dispatched:${candidate}`);
        rejectedReason = candidateReason;
      },
      rejectRemovedTurns: (candidate: string) => {
        calls.push(`pending-all:${candidate}`);
      },
    } as unknown as CodexPendingServerRequestRuntime["Service"]);
    const deltas = CodexConversationDeltaBufferRuntime.of({
      clear: (candidate: string) => calls.push(`deltas:${candidate}`),
    } as unknown as CodexConversationDeltaBufferRuntime["Service"]);
    const manualCompaction = CodexManualCompactionRuntime.of({
      clear: (candidate: string) => calls.push(`compaction:${candidate}`),
    } as unknown as CodexManualCompactionRuntime["Service"]);
    const presentation = yield* makePresentationRegistry;
    presentation.setPresented(threadId, "renderer-a", "surface-a", true);
    const managers = CodexMainConversationManagers.of({
      current: () => ({
        stream: { removeConversation: (candidate: string) => calls.push(`peer:${candidate}`) },
      }),
    } as unknown as CodexMainConversationManagers["Service"]);
    const browserUse = BrowserUseRuntime.of({
      releaseSession: (candidate: string) =>
        Effect.sync(() => {
          calls.push(`browser:${candidate}`);
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new BrowserUseRuntimeError({
                operation: "release-session",
                cause: new Error("browser already gone"),
              }),
            ),
          ),
        ),
    } as unknown as BrowserUseRuntime["Service"]);
    const lifecycle = yield* makeCodexConversationLifecycle.pipe(
      Effect.provideService(CodexConversationDeltaBufferRuntime, deltas),
      Effect.provideService(CodexManualCompactionRuntime, manualCompaction),
      Effect.provideService(CodexPendingServerRequestRuntime, pending),
      Effect.provideService(CodexMainConversationManagers, managers),
      Effect.provideService(CodexRendererPresentationRegistry, presentation),
      Effect.provideService(ConversationEntityMap, conversations),
      Effect.provideService(BrowserUseRuntime, browserUse),
    );

    const aggregate = conversations.entity(threadId);
    aggregate.installSnapshot(snapshot(threadId));
    aggregate.setStreaming(true);

    yield* conversations.runCommand(threadId, lifecycle.close(threadId, reason));

    assert.strictEqual(rejectedReason, reason);
    assert.deepEqual(calls, [
      "pending-dispatched:thread-a",
      "pending-all:thread-a",
      "deltas:thread-a",
      "compaction:thread-a",
      "peer:thread-a",
      "browser:thread-a",
    ]);
    assert.strictEqual(conversations.current(threadId), aggregate);
    assert.isNull(aggregate.readSnapshot());
    assert.isFalse(aggregate.isStreaming());
    assert.deepEqual(aggregate.readQueuedFollowUpProjection().entries, []);
    assert.isFalse(presentation.isClientPresenting(threadId, "renderer-a"));

    let laneRemainsUsable = false;
    yield* conversations.runCommand(
      threadId,
      Effect.sync(() => {
        laneRemainsUsable = true;
      }),
    );
    assert.isTrue(laneRemainsUsable);

    yield* Scope.close(ownerScope, Exit.void);
  }),
);
