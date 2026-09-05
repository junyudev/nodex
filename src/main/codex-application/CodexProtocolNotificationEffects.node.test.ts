import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";
import { CodexActiveGoalContinuation } from "./CodexActiveGoalContinuation";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexAutomationTurnCompletion } from "./CodexAutomationTurnCompletion";
import { CodexConversationDeltaBufferRuntime } from "./CodexConversationDeltaBufferRuntime";
import { CodexConversationLifecycle } from "./CodexConversationLifecycle";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexManualCompactionRuntime } from "./CodexManualCompactionRuntime";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { make } from "./CodexProtocolNotificationEffects";
import { CodexProtocolNotificationProjection } from "./CodexProtocolNotificationProjection";
import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { CodexRendererConversationCoordinator } from "./CodexRendererConversationCoordinator";
import { CodexRendererConversationRegistry } from "./CodexRendererConversationRegistry";
import { CodexThreadDurableProjection } from "./CodexThreadDurableProjection";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

it.effect("drains frame text before terminal turn consequences", () =>
  Effect.gen(function* () {
    const trace: string[] = [];
    const forwarded: CodexServerNotification[] = [];
    let deferLifecycle = false;
    const service = yield* make.pipe(
      Effect.provideService(
        CodexActiveGoalContinuation,
        CodexActiveGoalContinuation.of({} as CodexActiveGoalContinuation["Service"]),
      ),
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
      ),
      Effect.provideService(
        CodexAutomationTurnCompletion,
        CodexAutomationTurnCompletion.of({
          complete: () => Effect.sync(() => trace.push("automation")).pipe(Effect.as(true)),
        }),
      ),
      Effect.provideService(
        CodexConversationDeltaBufferRuntime,
        CodexConversationDeltaBufferRuntime.of({
          drainFrameText: () => {
            trace.push("drain");
          },
        } as unknown as CodexConversationDeltaBufferRuntime["Service"]),
      ),
      Effect.provideService(
        CodexConversationLifecycle,
        CodexConversationLifecycle.of({} as CodexConversationLifecycle["Service"]),
      ),
      Effect.provideService(
        CodexConversationProjection,
        CodexConversationProjection.of({
          reconcileThreadStatus: () => Effect.void,
        } as unknown as CodexConversationProjection["Service"]),
      ),
      Effect.provideService(
        CodexManualCompactionRuntime,
        CodexManualCompactionRuntime.of({} as CodexManualCompactionRuntime["Service"]),
      ),
      Effect.provideService(
        CodexPendingServerRequestRuntime,
        CodexPendingServerRequestRuntime.of({} as CodexPendingServerRequestRuntime["Service"]),
      ),
      Effect.provideService(
        CodexProtocolNotificationProjection,
        CodexProtocolNotificationProjection.of({ observe: () => Effect.succeed(false) }),
      ),
      Effect.provideService(
        CodexQueuedFollowUps,
        CodexQueuedFollowUps.of({
          list: () => [],
          requestDispatch: () => Effect.sync(() => trace.push("queue")),
          acceptTerminalOutcomeInCurrentLane: (
            input: Parameters<
              CodexQueuedFollowUps["Service"]["acceptTerminalOutcomeInCurrentLane"]
            >[0],
          ) =>
            Effect.sync(() =>
              trace.push(`queue-terminal:${input.interrupted}:${input.rows.length}`),
            ),
        } as unknown as CodexQueuedFollowUps["Service"]),
      ),
      Effect.provideService(
        CodexRendererConversationCoordinator,
        CodexRendererConversationCoordinator.of({
          forwardNotificationForConversation: (
            _threadId: string,
            notification: CodexServerNotification,
          ) => {
            forwarded.push(notification);
            return true;
          },
        } as unknown as CodexRendererConversationCoordinator["Service"]),
      ),
      Effect.provideService(
        CodexRendererConversationRegistry,
        CodexRendererConversationRegistry.of({} as CodexRendererConversationRegistry["Service"]),
      ),
      Effect.provideService(
        CodexThreadDurableProjection,
        CodexThreadDurableProjection.of({
          observe: ({ hostId, generation }) =>
            Effect.sync(() => trace.push(`durable:${hostId}:${generation}`)),
        }),
      ),
      Effect.provideService(
        CodexThreadDirectory,
        CodexThreadDirectory.of({} as unknown as CodexThreadDirectory["Service"]),
      ),
      Effect.provideService(
        CodexSubagentDirectory,
        CodexSubagentDirectory.of({
          readKnownOverview: ({ rootThreadId }: { readonly rootThreadId: string }) =>
            Effect.succeed({
              rootThreadId,
              revision: 0,
              generation: 7,
              completeness: "complete",
              active: { rows: [], knownCount: 0, totalCount: 0, continuation: null },
              done: { rows: [], knownCount: 0, totalCount: 0, continuation: null },
            }),
          observeNotification: () => Effect.void,
          shouldDeferLifecycleNotification: () => Effect.succeed(deferLifecycle),
        } as unknown as CodexSubagentDirectory["Service"]),
      ),
      Effect.provideService(
        CodexThreadGoalRuntime,
        CodexThreadGoalRuntime.of({} as CodexThreadGoalRuntime["Service"]),
      ),
      Effect.provideService(
        CodexUserInputAutoResolution,
        CodexUserInputAutoResolution.of({} as CodexUserInputAutoResolution["Service"]),
      ),
      Effect.provideService(
        ConversationEntityMap,
        ConversationEntityMap.of({
          current: () => null,
        } as unknown as ConversationEntityMap["Service"]),
      ),
      Effect.provideService(
        BrowserUseRuntime,
        BrowserUseRuntime.of({
          turnEnded: () => Effect.sync(() => trace.push("browser")),
        } as unknown as BrowserUseRuntime["Service"]),
      ),
      Effect.provideService(
        RemoteHostedPipRuntime,
        RemoteHostedPipRuntime.of({
          observeCodexOccurrence: () => Effect.sync(() => trace.push("pip")),
        } as unknown as RemoteHostedPipRuntime["Service"]),
      ),
    );
    const notification = {
      method: "turn/completed",
      params: {
        threadId: "thread-a",
        turn: {
          id: "turn-a",
          status: "completed",
          items: [],
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      },
    } as unknown as CodexServerNotification;

    yield* service.apply({
      hostId: "remote-a",
      generation: 7,
      notification,
      occurrenceId: "remote-a:7:inbox-a:91",
      occurrenceToken: 91,
    });

    assert.deepEqual(trace, [
      "drain",
      "browser",
      "pip",
      "automation",
      "queue",
      "durable:remote-a:7",
    ]);

    trace.length = 0;
    yield* service.apply({
      hostId: "remote-a",
      generation: 7,
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-a",
          turn: {
            id: "turn-a",
            status: "interrupted",
            items: [],
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
          },
        },
      } as unknown as CodexServerNotification,
      occurrenceId: "remote-a:7:inbox-a:92",
      occurrenceToken: 92,
    });

    assert.deepEqual(trace, [
      "drain",
      "browser",
      "pip",
      "automation",
      "queue-terminal:true:0",
      "durable:remote-a:7",
    ]);

    yield* service.apply({
      hostId: "remote-a",
      generation: 7,
      notification: {
        method: "item/started",
        params: {
          threadId: "thread-a",
          turnId: "turn-a",
          startedAtMs: 3,
          item: {
            questions: null,
            type: "agentMessage",
            id: "giant-item",
            text: "x".repeat(2 * 1_024 * 1_024 + 1),
            phase: null,
            memoryCitation: null,
            delivery: null,
          },
        },
      } as unknown as CodexServerNotification,
      occurrenceId: "remote-a:7:inbox-a:93",
      occurrenceToken: 93,
    });

    const forwardedItem = forwarded.findLast(
      (notification) => notification.method === "item/started",
    );
    if (!forwardedItem || forwardedItem.method !== "item/started") {
      throw new Error("Expected item lifecycle notification to be forwarded");
    }
    assert.strictEqual(forwardedItem.params.threadId, "thread-a");
    assert.strictEqual(forwardedItem.params.turnId, "turn-a");
    assert.strictEqual(forwardedItem.params.startedAtMs, 3);
    assert.strictEqual(forwardedItem.params.item.id, "giant-item");
    assert.strictEqual(forwardedItem.params.item.type, "agentMessage");
    if (forwardedItem.params.item.type !== "agentMessage") {
      throw new Error("Expected overflowing lifecycle item to become an agent message");
    }
    assert.strictEqual(
      forwardedItem.params.item.text,
      "Live output exceeded the resident Turn limit. Additional output was omitted from memory; the persisted transcript remains authoritative.",
    );

    trace.length = 0;
    deferLifecycle = true;
    const archivedDisposition = yield* service.apply({
      hostId: "remote-a",
      generation: 7,
      notification: {
        method: "thread/archived",
        params: { threadId: "thread-a" },
      } as CodexServerNotification,
      occurrenceId: "remote-a:7:inbox-a:94",
      occurrenceToken: 94,
    });
    assert.strictEqual(archivedDisposition, "retain");
    assert.notInclude(trace, "pip");

    trace.length = 0;
    const deletedDisposition = yield* service.apply({
      hostId: "remote-a",
      generation: 7,
      notification: {
        method: "thread/deleted",
        params: { threadId: "thread-a" },
      } as CodexServerNotification,
      occurrenceId: "remote-a:7:inbox-a:95",
      occurrenceToken: 95,
    });
    assert.strictEqual(deletedDisposition, "retain");
    assert.notInclude(trace, "pip");
  }),
);
