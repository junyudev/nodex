import type { CodexHeartbeatDecision } from "../../shared/codex-turn-notification";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";
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
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexThreadDurableProjection } from "./CodexThreadDurableProjection";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadTitleReconsideration } from "./CodexThreadTitleReconsideration";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

it.effect("drains only Main-owned prose before applying terminal product consequences", () =>
  Effect.gen(function* () {
    const trace: string[] = [];
    let automationDecision: CodexHeartbeatDecision | null = "DONT_NOTIFY";
    let streamRole: ConversationStreamRole = { role: "owner" };
    const deliveredDecisions: Array<CodexHeartbeatDecision | null> = [];
    const deliveredHosts: string[] = [];
    const service = yield* make.pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: (event) => {
            if (event.kind === "threadNotification" && event.value.type === "turn-completed") {
              deliveredDecisions.push(event.value.automationNotificationDecision ?? null);
              deliveredHosts.push(event.value.hostId);
            }
          },
        }),
      ),
      Effect.provideService(
        CodexAutomationTurnCompletion,
        CodexAutomationTurnCompletion.of({
          complete: () =>
            Effect.sync(() => trace.push("automation")).pipe(Effect.map(() => automationDecision)),
        }),
      ),
      Effect.provideService(
        CodexConversationDeltaBufferRuntime,
        CodexConversationDeltaBufferRuntime.of({
          drainBeforeCompletion: () => {
            trace.push("drain");
          },
        } as unknown as CodexConversationDeltaBufferRuntime["Service"]),
      ),
      Effect.provideService(
        CodexConversationLifecycle,
        CodexConversationLifecycle.of({
          close: () =>
            Effect.sync(() => {
              trace.push("close");
            }),
        } as unknown as CodexConversationLifecycle["Service"]),
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
          readHead: () => null,
          acceptTerminalOutcomeInCurrentLane: (
            input: Parameters<
              CodexQueuedFollowUps["Service"]["acceptTerminalOutcomeInCurrentLane"]
            >[0],
          ) => Effect.sync(() => trace.push(`queue-terminal:${input.interrupted}:0`)),
        } as unknown as CodexQueuedFollowUps["Service"]),
      ),
      Effect.provideService(CodexMainConversationManagers, {
        current: () => ({ generation: 7, stream: { getRole: () => streamRole } }),
      } as unknown as CodexMainConversationManagers["Service"]),
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
        } as unknown as CodexSubagentDirectory["Service"]),
      ),
      Effect.provideService(
        CodexThreadGoalRuntime,
        CodexThreadGoalRuntime.of({} as CodexThreadGoalRuntime["Service"]),
      ),
      Effect.provideService(
        CodexThreadTitleReconsideration,
        CodexThreadTitleReconsideration.of({ observe: () => Effect.void }),
      ),
      Effect.provideService(
        CodexUserInputAutoResolution,
        CodexUserInputAutoResolution.of({} as CodexUserInputAutoResolution["Service"]),
      ),
      Effect.provideService(
        ConversationEntityMap,
        ConversationEntityMap.of({
          registerThreadMetadata: () => {},
          readThreadMetadata: () => null,
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

    assert.deepEqual(trace, ["drain", "browser", "pip", "automation", "durable:remote-a:7"]);

    assert.deepEqual(deliveredDecisions, ["DONT_NOTIFY"]);
    automationDecision = null;
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

    assert.deepEqual(deliveredDecisions, ["DONT_NOTIFY", null]);

    trace.length = 0;
    streamRole = { role: "follower", ownerClientId: "renderer-owner" };
    yield* service.apply({
      hostId: "remote-a",
      generation: 7,
      notification,
      occurrenceId: "remote-a:7:inbox-a:93",
      occurrenceToken: 93,
    });
    assert.deepEqual(trace, ["browser", "pip", "automation", "durable:remote-a:7"]);
    assert.deepEqual(deliveredDecisions, ["DONT_NOTIFY", null, null]);
    assert.deepEqual(deliveredHosts, ["remote-a", "remote-a", "remote-a"]);

    trace.length = 0;
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
    assert.strictEqual(archivedDisposition, "retire");
    assert.deepEqual(trace, ["durable:remote-a:7", "close", "pip"]);

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
    assert.strictEqual(deletedDisposition, "retire");
    assert.deepEqual(trace, ["durable:remote-a:7", "close", "pip"]);
  }),
);
