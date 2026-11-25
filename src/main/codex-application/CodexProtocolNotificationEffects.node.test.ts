import { describe } from "vite-plus/test";
import { CodexVisualizationState, CodexVisualizationStateError } from "./CodexVisualizationState";
import type { CodexHeartbeatDecision } from "../../shared/codex-turn-notification";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";
import type { CodexHostMessage } from "../../shared/types";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
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
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap, live as entityMapLive } from "./internal/ConversationEntityMap";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalTimelineEntry,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import { buildAgentActivityV2CorpusThread } from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { produce } from "immer";
import type { ThreadRealtimeItem, Thread, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Scope from "effect/Scope";
import { MainConfig, testLayer as mainConfigTestLayer } from "../app/MainConfig";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";
import { codexLinkedRootSessionFixture } from "../core-client/testing/codex-linked-root-session.test-support";
import { CodexTurnPresentation } from "../../host/TurnPresentation";
import {
  makeTestTurnPresentation,
  testSubmitPresentation,
} from "./CodexTurnPresentation.test-support";
import * as Exit from "effect/Exit";
import {
  CodexInternalThreadRegistry,
  make as makeInternalThreads,
} from "./CodexInternalThreadRegistry";
import { make as makeCodexNotificationAdmission } from "./CodexNotificationAdmission";
import { CodexTurnAuthority } from "./CodexTurnAuthority";
import { CoreModules } from "../core-runtime/CoreModules";

describe("CodexProtocolNotificationEffects", () => {
  const liveNativeState = (threadId: string, hostId: string) =>
    createCodexCanonicalHydratedConversationState(
      { ...buildAgentActivityV2CorpusThread([]), id: threadId, turns: [] },
      {
        hostId,
        model: "fixture-model",
        reasoningEffort: null,
        cwd: "/workspace",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: [],
      },
    );

  it.effect("drains only Main-owned prose before applying terminal product consequences", () =>
    Effect.gen(function* () {
      const trace: string[] = [];
      let streamRole: ConversationStreamRole = { role: "owner" };
      let widgetClearFailure = false;
      const deliveredDecisions: Array<CodexHeartbeatDecision | null> = [];
      const deliveredHosts: string[] = [];
      const completions: Extract<CodexHostMessage, { type: "threadReadActivity" }>[] = [];
      const completionConsequences: string[][] = [];
      const targetChanges: {
        type: "createdThreadTargetChanged";
        hostId: string;
        threadId: string;
      }[] = [];
      const mapContext = yield* Layer.build(entityMapLive);
      const entityMap = Context.get(mapContext, ConversationEntityMap);
      const conversations = { ...entityMap, acquire: entityMap.entity };
      const manager = { generation: 7, stream: { getRole: () => streamRole } };
      let acceptsTerminal = true;
      let terminalAdmissionGate = Effect.void;
      let durableGate = Effect.void;
      const service = yield* make
        .pipe(
          Effect.provideService(
            CodexVisualizationState,
            CodexVisualizationState.of({
              read: () => Effect.succeed(null),
              write: () => Effect.die("unused"),
              writeInteraction: () => Effect.die("unused"),
              readPassiveContext: () => Effect.succeed(undefined),
              readUnsentPassiveContext: () => Effect.succeed(undefined),
              markPassiveContextSent: () => Effect.void,
              clearThread: (scope) =>
                widgetClearFailure
                  ? Effect.fail(
                      new CodexVisualizationStateError({
                        operation: "clear-thread",
                        cause: new Error("Profile file unavailable"),
                      }),
                    )
                  : Effect.sync(() => {
                      trace.push(`widgets:clear:${scope.hostId}:${scope.threadId}`);
                      return [];
                    }),
            }),
          ),
        )
        .pipe(
          Effect.provideService(CodexAppServerCapabilities, {
            forHost: () =>
              Effect.die("This legacy notification fixture must not acquire timeline capabilities"),
          } as unknown as CodexAppServerCapabilities["Service"]),
          Effect.provideService(
            CodexApplicationEventHub,
            CodexApplicationEventHub.of({
              events: Stream.empty,
              publish: (event) => {
                if (event.kind === "hostMessage" && event.value.type === "threadReadActivity") {
                  completions.push(event.value);
                  completionConsequences.push([...trace]);
                }
                if (event.kind === "codex" && event.value.type === "createdThreadTargetChanged")
                  targetChanges.push(event.value);
                if (event.kind === "threadNotification" && event.value.type === "turn-completed") {
                  deliveredDecisions.push(event.value.automationNotificationDecision ?? null);
                  deliveredHosts.push(event.value.hostId);
                }
              },
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
            current: () => manager,
          } as unknown as CodexMainConversationManagers["Service"]),
          Effect.provideService(
            CodexThreadDurableProjection,
            CodexThreadDurableProjection.of({
              acceptsTerminalObservation: () =>
                terminalAdmissionGate.pipe(Effect.as(acceptsTerminal)),
              observe: ({ hostId, generation }) =>
                durableGate.pipe(
                  Effect.andThen(Effect.sync(() => trace.push(`durable:${hostId}:${generation}`))),
                ),
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
            CodexUserInputAutoResolution,
            CodexUserInputAutoResolution.of({} as CodexUserInputAutoResolution["Service"]),
          ),
          Effect.provideService(ConversationEntityMap, entityMap),
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
        "queue-terminal:false:0",
        "durable:remote-a:7",
      ]);

      assert.deepEqual(deliveredDecisions, [null]);
      assert.deepEqual(targetChanges, [
        { type: "createdThreadTargetChanged", hostId: "remote-a", threadId: "thread-a" },
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
        "queue-terminal:true:0",
        "durable:remote-a:7",
      ]);

      assert.deepEqual(deliveredDecisions, [null, null]);

      trace.length = 0;
      streamRole = { role: "follower", ownerClientId: "renderer-owner" };
      yield* service.apply({
        hostId: "remote-a",
        generation: 7,
        notification,
        occurrenceId: "remote-a:7:inbox-a:93",
        occurrenceToken: 93,
      });
      assert.deepEqual(trace, ["browser", "pip", "queue-terminal:false:0", "durable:remote-a:7"]);
      assert.deepEqual(deliveredDecisions, [null, null, null]);
      assert.deepEqual(deliveredHosts, ["remote-a", "remote-a", "remote-a"]);
      assert.deepEqual(completions, [
        {
          type: "threadReadActivity",
          hostId: "remote-a",
          conversationId: "thread-a",
          activity: { type: "turn-completed", turnId: "turn-a" },
        },
        {
          type: "threadReadActivity",
          hostId: "remote-a",
          conversationId: "thread-a",
          activity: { type: "turn-completed", turnId: "turn-a" },
        },
        {
          type: "threadReadActivity",
          hostId: "remote-a",
          conversationId: "thread-a",
          activity: { type: "turn-completed", turnId: "turn-a" },
        },
      ]);
      assert.isTrue(completionConsequences.every((steps) => steps.at(-1) === "durable:remote-a:7"));

      const completionEntered = yield* Deferred.make<void>();
      const releaseCompletion = yield* Deferred.make<void>();
      durableGate = Deferred.succeed(completionEntered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseCompletion)),
      );
      const retiredCompletion = yield* service
        .apply({
          hostId: "remote-a",
          generation: 7,
          notification,
          occurrenceId: "completion-before-reconnect",
          occurrenceToken: 94,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(completionEntered);
      manager.generation = 8;
      yield* Deferred.succeed(releaseCompletion, undefined);
      yield* Fiber.join(retiredCompletion);
      assert.strictEqual(completions.length, 3);
      manager.generation = 7;
      durableGate = Effect.void;

      trace.length = 0;
      conversations
        .acquire("thread-a")
        .installFollowerCanonicalState(liveNativeState("thread-a", "remote-a"));
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
      assert.deepEqual(trace, [
        "widgets:clear:remote-a:thread-a",
        "durable:remote-a:7",
        "close",
        "pip",
      ]);
      trace.length = 0;
      widgetClearFailure = true;
      assert.strictEqual(
        yield* service.apply({
          hostId: "remote-a",
          generation: 7,
          notification: {
            method: "thread/deleted",
            params: { threadId: "thread-a" },
          } as CodexServerNotification,
          occurrenceId: "remote-a:7:inbox-a:96",
          occurrenceToken: 96,
        }),
        "retire",
      );
      assert.deepEqual(trace, ["durable:remote-a:7", "close", "pip"]);
      widgetClearFailure = false;

      trace.length = 0;
      acceptsTerminal = false;
      assert.strictEqual(
        yield* service.apply({
          hostId: "remote-a",
          generation: 7,
          notification: { method: "thread/deleted", params: { threadId: "thread-a" } },
          occurrenceId: "foreign-core-row",
          occurrenceToken: 98,
        }),
        "retain",
      );
      assert.deepEqual(trace, []);
      acceptsTerminal = true;
      const original = conversations.current("thread-a");
      original!.installFollowerCanonicalState(liveNativeState("thread-a", "local"));
      assert.strictEqual(
        yield* service.apply({
          hostId: "remote-a",
          generation: 7,
          notification: { method: "thread/archived", params: { threadId: "thread-a" } },
          occurrenceId: "foreign-canonical",
          occurrenceToken: 99,
        }),
        "retain",
      );
      assert.deepEqual(trace, []);
      assert.strictEqual(conversations.current("thread-a"), original);

      const admissionEntered = yield* Deferred.make<void>();
      const releaseAdmission = yield* Deferred.make<void>();
      original!.installFollowerCanonicalState(liveNativeState("thread-a", "remote-a"));
      terminalAdmissionGate = Deferred.succeed(admissionEntered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseAdmission)),
      );
      const oldAdmission = yield* service
        .apply({
          hostId: "remote-a",
          generation: 7,
          notification: { method: "thread/deleted", params: { threadId: "thread-a" } },
          occurrenceId: "held-core-admission",
          occurrenceToken: 100,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(admissionEntered);
      yield* conversations.retire("thread-a");
      const foreignReplacement = conversations.entity("thread-a");
      foreignReplacement.installFollowerCanonicalState(liveNativeState("thread-a", "local"));
      yield* Deferred.succeed(releaseAdmission, undefined);
      assert.strictEqual(yield* Fiber.join(oldAdmission), "retain");
      assert.deepEqual(trace, []);
      assert.strictEqual(conversations.current("thread-a"), foreignReplacement);
      assert.strictEqual(foreignReplacement.readCanonicalState()?.hostId, "local");
      terminalAdmissionGate = Effect.void;

      foreignReplacement.installFollowerCanonicalState(liveNativeState("thread-a", "remote-a"));
      const durableEntered = yield* Deferred.make<void>();
      const releaseDurable = yield* Deferred.make<void>();
      durableGate = Deferred.succeed(durableEntered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseDurable)),
      );
      const oldDurable = yield* service
        .apply({
          hostId: "remote-a",
          generation: 7,
          notification: { method: "thread/archived", params: { threadId: "thread-a" } },
          occurrenceId: "held-durable-consequence",
          occurrenceToken: 101,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(durableEntered);
      yield* conversations.retire("thread-a");
      const sameHostReplacement = conversations.entity("thread-a");
      sameHostReplacement.installFollowerCanonicalState(liveNativeState("thread-a", "remote-a"));
      const replacementState = sameHostReplacement.readCanonicalState();
      yield* Deferred.succeed(releaseDurable, undefined);
      yield* Fiber.join(oldDurable);
      assert.deepEqual(trace, ["durable:remote-a:7"]);
      assert.strictEqual(conversations.current("thread-a"), sameHostReplacement);
      assert.strictEqual(sameHostReplacement.readCanonicalState(), replacementState);
      durableGate = Effect.void;
      trace.length = 0;

      const coldEntered = yield* Deferred.make<void>();
      const cold = yield* conversations
        .admitExecution(
          "cold-thread",
          { hostId: "local", generation: 7 },
          Deferred.succeed(coldEntered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(coldEntered);
      const coldEntity = conversations.current("cold-thread");
      assert.isNull(coldEntity?.readCanonicalState());
      assert.strictEqual(
        yield* service.apply({
          hostId: "remote-a",
          generation: 7,
          notification: { method: "thread/archived", params: { threadId: "cold-thread" } },
          occurrenceId: "foreign-cold-source",
          occurrenceToken: 102,
        }),
        "retain",
      );
      assert.deepEqual(trace, ["durable:remote-a:7"]);
      assert.strictEqual(conversations.current("cold-thread"), coldEntity);
      assert.isNotNull(
        conversations.captureNativeTerminalTarget("cold-thread", {
          hostId: "local",
          generation: 7,
        }),
      );
      yield* Fiber.interrupt(cold);
      trace.length = 0;

      streamRole = { role: "owner" };
      const entity = conversations.acquire("thread-a");
      for (const mode of ["legacy", "canonical"] as const) {
        const metadata = buildAgentActivityV2CorpusThread([
          {
            type: "commandExecution",
            id: "command-a",
            pluginId: null,
            scriptPath: null,
            command: "cat",
            cwd: "/work",
            processId: "process-a",
            source: "agent",
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        ]);
        const state = createCodexCanonicalHydratedConversationState(
          {
            ...metadata,
            id: "thread-a",
            turns: metadata.turns.map((turn) => ({ ...turn, id: "turn-a", status: "inProgress" })),
          },
          {
            hostId: "remote-a",
            model: "fixture-model",
            reasoningEffort: null,
            cwd: "/work",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            activePermissionProfile: null,
            runtimeWorkspaceRoots: ["/work"],
          },
        );
        entity.acceptCanonicalState(
          mode === "canonical"
            ? produce(state, (draft) => replaceCanonicalHistoryDraft(draft, state.turns, true))
            : state,
        );
        const input = (stdin: string): CodexServerNotification => ({
          method: "item/commandExecution/terminalInteraction",
          params: {
            threadId: "thread-a",
            turnId: "turn-a",
            itemId: "command-a",
            processId: "process-a",
            stdin,
          },
        });
        const apply = (next: CodexServerNotification) =>
          service.apply({
            hostId: "remote-a",
            generation: 7,
            notification: next,
            occurrenceId: "remote-a:7:inbox-a:96",
            occurrenceToken: 96,
          });
        yield* apply(input("discarded-prefix"));
        yield* apply(notification);
        yield* apply(input("fresh\n"));
        const command = residentConversationTurns(entity.readCanonicalState())[0]!.items.find(
          (item) => item.id === "command-a",
        );
        assert.equal(command?.type, "commandExecution");
        if (command?.type !== "commandExecution") return;
        assert.deepStrictEqual(command.commandActions, [{ type: "unknown", command: "fresh" }]);
      }
    }).pipe(Effect.scoped),
  );
});

describe("CodexProtocolNotificationTimeline", () => {
  const fixture = Effect.fn("notificationTimelineTest.fixture")(function* (
    options: {
      readonly hostId?: string;
      readonly stateHostId?: string;
      readonly version?: string;
      readonly enabled?: boolean;
      readonly capabilityHostId?: string;
      readonly capabilityGeneration?: number;
      readonly holdCapability?: boolean;
    } = {},
  ) {
    const hostId = options.hostId ?? "local";
    const registry = makeConversationEntityStateRegistry();
    const entity = registry.acquire("thread");
    entity.acceptCanonicalState(
      createCodexCanonicalHydratedConversationState(
        {
          ...buildAgentActivityV2CorpusThread([]),
          id: "thread",
          cliVersion: "0.162.0-alpha.17.2",
          turns: [],
        },
        {
          hostId: options.stateHostId ?? hostId,
          model: "test",
          reasoningEffort: null,
          cwd: "/workspace",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null,
          runtimeWorkspaceRoots: ["/workspace"],
        },
      ),
    );
    let generation = 7;
    let role: ConversationStreamRole = { role: "owner" };
    const manager = {
      hostId,
      get generation() {
        return generation;
      },
      stream: { getRole: () => role },
    };
    const requested = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    let capabilityReads = 0;
    const consequences: string[] = [];
    const capability = createCodexAppServerCapabilitySnapshot({
      hostId: options.capabilityHostId ?? hostId,
      generation: options.capabilityGeneration ?? generation,
      userAgent: `codex/${options.version ?? "0.162.0-alpha.17.2"}`,
    });
    const config = Context.get(
      yield* Layer.buildWithScope(
        mainConfigTestLayer({
          environment:
            options.enabled === false
              ? {}
              : { NODEX_DEV_ENABLED_FEATURES: "thread-timeline-history" },
        }),
        yield* Scope.Scope,
      ),
      MainConfig,
    );
    const service = yield* make
      .pipe(
        Effect.provideService(
          CodexVisualizationState,
          CodexVisualizationState.of({
            read: () => Effect.succeed(null),
            write: () => Effect.die("unused"),
            writeInteraction: () => Effect.die("unused"),
            readPassiveContext: () => Effect.succeed(undefined),
            readUnsentPassiveContext: () => Effect.succeed(undefined),
            markPassiveContextSent: () => Effect.void,
            clearThread: () => Effect.succeed([]),
          }),
        ),
      )
      .pipe(
        Effect.provideService(MainConfig, config),
        Effect.provideService(CodexAppServerCapabilities, {
          forHost: (requestedHost: string) =>
            Effect.gen(function* () {
              assert.strictEqual(requestedHost, hostId);
              capabilityReads += 1;
              yield* Deferred.succeed(requested, undefined);
              if (options.holdCapability) yield* Deferred.await(released);
              return capability;
            }),
        } as unknown as CodexAppServerCapabilities["Service"]),
        Effect.provideService(CodexMainConversationManagers, {
          current: () => manager,
        } as unknown as CodexMainConversationManagers["Service"]),
        Effect.provideService(ConversationEntityMap, {
          current: registry.current,
          readThreadMetadata: registry.readThreadMetadata,
        } as unknown as ConversationEntityMap["Service"]),
        Effect.provideService(CodexApplicationEventHub, {
          events: Stream.empty,
          publish: (event) => consequences.push(event.kind),
        }),
        Effect.provideService(CodexProtocolNotificationProjection, {
          observe: () => Effect.succeed(false),
        }),
        Effect.provideService(CodexSubagentDirectory, {
          observeNotification: () =>
            Effect.sync(() => {
              consequences.push("subagents");
            }),
        } as unknown as CodexSubagentDirectory["Service"]),
        Effect.provideService(CodexThreadDurableProjection, {
          acceptsTerminalObservation: () => Effect.succeed(true),
          observe: () =>
            Effect.sync(() => {
              consequences.push("durable");
            }),
        }),
        Effect.provideService(RemoteHostedPipRuntime, {
          observeCodexOccurrence: () =>
            Effect.sync(() => {
              consequences.push("pip");
            }),
        } as unknown as RemoteHostedPipRuntime["Service"]),
        Effect.provideService(CodexConversationDeltaBufferRuntime, {
          drainBeforeCompletion: () => {},
        } as unknown as CodexConversationDeltaBufferRuntime["Service"]),
        Effect.provideService(CodexManualCompactionRuntime, {
          consumeSource: () => "automatic",
        } as unknown as CodexManualCompactionRuntime["Service"]),
        Effect.provideService(
          CodexConversationLifecycle,
          {} as CodexConversationLifecycle["Service"],
        ),
        Effect.provideService(
          CodexConversationProjection,
          {} as CodexConversationProjection["Service"],
        ),
        Effect.provideService(
          CodexPendingServerRequestRuntime,
          {} as CodexPendingServerRequestRuntime["Service"],
        ),
        Effect.provideService(CodexQueuedFollowUps, {} as CodexQueuedFollowUps["Service"]),
        Effect.provideService(CodexThreadGoalRuntime, {} as CodexThreadGoalRuntime["Service"]),
        Effect.provideService(
          CodexUserInputAutoResolution,
          {} as CodexUserInputAutoResolution["Service"],
        ),
        Effect.provideService(BrowserUseRuntime, {} as BrowserUseRuntime["Service"]),
      );
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.releaseAll()));
    return {
      entity,
      consequences,
      registry,
      requested,
      released,
      capabilityReads: () => capabilityReads,
      setRole: (next: ConversationStreamRole) => {
        role = next;
      },
      reset: () => {
        generation += 1;
      },
      apply: (notification: CodexServerNotification) =>
        service.apply({
          hostId,
          generation: 7,
          notification,
          occurrenceId: `${hostId}:7:1`,
          occurrenceToken: 1,
        }),
    };
  });

  const transcript = (text: string): ThreadRealtimeItem => ({
    type: "transcriptSegment",
    id: "segment",
    realtimeSessionId: "session",
    role: "assistant",
    text,
  });
  const started: CodexServerNotification = {
    method: "thread/realtime/item/started",
    params: { threadId: "thread", item: transcript("first") },
  };

  it.effect(
    "Main notification ownership streams and completes native rows without changing their timeline identity",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.apply(started);
        yield* f.apply({
          method: "thread/realtime/item/transcript/delta",
          params: { threadId: "thread", itemId: "segment", delta: " delta" },
        });
        assert.deepEqual(
          f.entity.readCanonicalState()?.realtimeItems?.segment?.item,
          transcript("first delta"),
        );
        yield* f.apply({
          method: "thread/realtime/item/completed",
          params: { threadId: "thread", item: transcript("final") },
        });
        yield* f.apply(started);
        const item: ThreadRealtimeItem = {
          type: "bemItemPromoted",
          id: "receipt",
          realtimeSessionId: "session",
          turnId: "missing-turn",
          itemId: "missing-item",
          presentation: { type: "wholeItem" },
        };
        yield* f.apply({
          method: "thread/realtime/item/completed",
          params: { threadId: "thread", item },
        });
        assert.deepEqual(f.entity.readCanonicalState()?.itemTimeline?.entries, [
          { type: "realtime", position: 1, item: transcript("final") },
          { type: "realtime", position: 2, item },
        ]);
        assert.deepEqual(f.entity.readCanonicalState()?.realtimeItems?.segment, {
          item: transcript("final"),
          completed: true,
        });
        assert.deepEqual(f.entity.readCanonicalState()?.turns, []);
        const plan = { type: "plan" as const, id: "plan", text: "Next" };
        yield* f.apply({
          method: "item/started",
          params: { threadId: "thread", turnId: "turn", item: plan, startedAtMs: 1 },
        });
        yield* f.apply({
          method: "item/completed",
          params: { threadId: "thread", turnId: "turn", item: plan, completedAtMs: 2 },
        });
        assert.deepEqual(f.entity.readCanonicalState()?.itemTimeline?.entries.at(-1), {
          type: "item",
          position: 3,
          turnId: "turn",
          item: { id: "plan", type: "plan", completed: true },
        });
      }),
  );

  it.effect.each([
    { enabled: false },
    { version: "0.149.0" },
    { hostId: "durable" },
    { capabilityHostId: "other" },
    { capabilityGeneration: 8 },
    { stateHostId: "other" },
  ])("Main timeline mutation rejects disabled or nonmatching physical policy %#", (options) =>
    Effect.gen(function* () {
      const f = yield* fixture(options);
      const before = f.entity.readCanonicalState();
      yield* f.apply(started);
      assert.strictEqual(f.entity.readCanonicalState(), before);
    }),
  );

  it.effect.each(["reset", "follower", "retire"] as const)(
    "Main capability acquisition fences a concurrent %s before committing the native row",
    (change) =>
      Effect.gen(function* () {
        const completed: CodexServerNotification = {
          method: "item/completed",
          params: {
            threadId: "thread",
            turnId: "turn",
            completedAtMs: 1,
            item: { type: "plan", id: "plan", text: "Next" },
          },
        };
        for (const notification of [started, completed]) {
          const f = yield* fixture({ holdCapability: true });
          const before = f.entity.readCanonicalState();
          const fiber = yield* Effect.forkScoped(f.apply(notification));
          yield* Deferred.await(f.requested);
          if (change === "reset") f.reset();
          if (change === "follower") f.setRole({ role: "follower", ownerClientId: "renderer" });
          if (change === "retire") f.registry.releaseGeneration("thread", f.entity.generation);
          yield* Deferred.succeed(f.released, undefined);
          yield* Fiber.join(fiber);
          if (change !== "retire") assert.strictEqual(f.entity.readCanonicalState(), before);
          else assert.isNull(f.registry.current("thread"));
          assert.strictEqual(f.capabilityReads(), 1);
          assert.deepEqual(f.consequences, []);
        }
      }),
  );

  it.effect(
    "a renderer-owned follower receives no second Main timeline mutation or capability read",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setRole({ role: "follower", ownerClientId: "renderer" });
        const before = f.entity.readCanonicalState();
        yield* f.apply(started);
        assert.strictEqual(f.entity.readCanonicalState(), before);
        assert.strictEqual(f.capabilityReads(), 0);
      }),
  );

  it.effect("Main sparse append and completion reuse the admitted 10,000-row identity index", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let residentItemReads = 0;
      const entries: CodexCanonicalTimelineEntry[] = Array.from({ length: 10_000 }, (_, index) => {
        const item: ThreadRealtimeItem = Object.freeze({
          ...transcript(String(index)),
          id: String(index),
        });
        return Object.freeze({
          type: "realtime" as const,
          position: index + 1,
          get item() {
            residentItemReads += 1;
            return item;
          },
        });
      });
      f.entity.acceptCanonicalState({
        ...f.entity.readCanonicalState()!,
        itemTimeline: Object.freeze({
          activeRealtimeSessionAtPageStart: null,
          entries: Object.freeze(entries),
        }),
      });
      yield* f.apply({
        method: "thread/realtime/item/completed",
        params: { threadId: "thread", item: { ...transcript("prime"), id: "0" } },
      });
      assert.isAtLeast(residentItemReads, 10_000);
      residentItemReads = 0;
      yield* f.apply(started);
      yield* f.apply({
        method: "thread/realtime/item/transcript/delta",
        params: { threadId: "thread", itemId: "segment", delta: " delta" },
      });
      yield* f.apply({
        method: "thread/realtime/item/completed",
        params: { threadId: "thread", item: transcript("final") },
      });
      yield* f.apply({
        method: "thread/realtime/item/completed",
        params: { threadId: "thread", item: { ...transcript("last revised"), id: "9999" } },
      });
      // Only the exact resident entry being completed may be read; no history-wide scan is allowed.
      assert.isAtMost(residentItemReads, 4);
      const timeline = f.entity.readCanonicalState()?.itemTimeline;
      assert.strictEqual(timeline?.entries.length, 10_001);
      assert.deepEqual(timeline?.entries.at(-1), {
        type: "realtime",
        position: 10_001,
        item: transcript("final"),
      });
      assert.deepEqual(timeline?.entries[9999], {
        type: "realtime",
        position: 10_000,
        item: { ...transcript("last revised"), id: "9999" },
      });
    }),
  );

  it.effect(
    "Main history replacement rebuilds native identity positions before the next completion",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.apply(started);
        yield* f.apply({
          method: "thread/realtime/item/completed",
          params: { threadId: "thread", item: transcript("old final") },
        });
        f.entity.mutateCanonicalState((draft) => {
          draft.itemTimeline!.entries = [
            { type: "realtime", position: 0, item: { ...transcript("older"), id: "older" } },
            ...draft.itemTimeline!.entries,
          ];
        }, 2);
        yield* f.apply({
          method: "thread/realtime/item/completed",
          params: { threadId: "thread", item: transcript("new final") },
        });
        assert.deepEqual(f.entity.readCanonicalState()?.itemTimeline?.entries, [
          { type: "realtime", position: 0, item: { ...transcript("older"), id: "older" } },
          { type: "realtime", position: 1, item: transcript("new final") },
        ]);
      }),
  );
});

describe("CodexNotificationAdmission", () => {
  const make = makeCodexNotificationAdmission;
  const thread = (input: {
    readonly id: string;
    readonly ephemeral?: boolean;
    readonly parentThreadId?: string | null;
    readonly threadSource?: string | null;
    readonly source?: Thread["source"];
  }): Thread =>
    ({
      id: input.id,
      ephemeral: input.ephemeral ?? false,
      parentThreadId: input.parentThreadId ?? null,
      threadSource: input.threadSource ?? null,
      source: input.source ?? "appServer",
      turns: [],
    }) as unknown as Thread;

  const startedThread = (value: Thread): CodexServerNotification => ({
    method: "thread/started",
    params: { thread: value },
  });

  const startedTurn = (threadId: string, turnId: string): CodexServerNotification => ({
    method: "turn/started",
    params: {
      threadId,
      turn: { id: turnId, status: "inProgress", items: [] } as unknown as Turn,
    },
  });

  const delta = (threadId: string): CodexServerNotification => ({
    method: "item/agentMessage/delta",
    params: { threadId, turnId: "turn-a", itemId: "message-a", delta: "next" },
  });

  const makeHarness = (trace: string[], core?: CoreModules["Service"]) =>
    Effect.gen(function* () {
      const internalThreads = yield* makeInternalThreads;
      const knownSubagents = new Set<string>();
      const fullFidelitySubagents = new Set<string>();
      const subagents = CodexSubagentDirectory.of({
        readOverview: () => Effect.die("unused"),
        readKnownOverview: () => Effect.die("unused"),
        hydrateSelected: ({ rootThreadId, threadId }) =>
          Effect.sync(() => {
            fullFidelitySubagents.add(threadId);
            return {
              rootThreadId,
              threadId,
              revision: 1,
              fidelity: "attachedSparse" as const,
              checkpoint: "1",
              canInteract: true,
              outcome: "ready" as const,
              errorMessage: null,
            };
          }),
        observeNotification: () => Effect.void,
        reconcileAfterReconnect: () => Effect.void,
        settleInterruptedSubtree: () => Effect.die("unused"),
        observe: (threadId) => {
          trace.push(`subagent:observe:${threadId}`);
          knownSubagents.add(threadId);
        },
        shouldDropDelta: (method, threadId) =>
          method === "item/agentMessage/delta" &&
          threadId !== null &&
          knownSubagents.has(threadId) &&
          !fullFidelitySubagents.has(threadId),
        clear: (threadId) => {
          knownSubagents.delete(threadId);
          fullFidelitySubagents.delete(threadId);
        },
      });
      const authority = CodexTurnAuthority.of({
        begin: () => Effect.die("unused"),
        bind: () => Effect.die("unused"),
        observeStarted: (threadId, turnId) =>
          Effect.sync(() => trace.push(`authority:observe:${threadId}:${turnId}`)),
        capture: () => Effect.die("Native child observations cannot choose a parent execution"),
        abort: () => undefined,
      });
      const presentation = yield* makeTestTurnPresentation;
      const admission = yield* make.pipe(
        Effect.provideService(
          CoreModules,
          core ??
            ({
              workspace: {
                read: () => Effect.die("Unqualified legacy admission must not query Core"),
              },
            } as unknown as CoreModules["Service"]),
        ),
        Effect.provideService(CodexInternalThreadRegistry, internalThreads),
        Effect.provideService(CodexSubagentDirectory, subagents),
        Effect.provideService(CodexTurnAuthority, authority),
        Effect.provideService(CodexTurnPresentation, presentation),
      );
      return { admission, internalThreads, subagents, presentation };
    });

  it.effect(
    "admits a Core-linked root with a subagent label and keeps subsequent deltas free of Core reads",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const core = CoreModules.of({
          workspace: {
            read: (input: Parameters<CoreModules["Service"]["workspace"]["read"]>[0]) =>
              Effect.sync(() => {
                reads++;
                assert.deepStrictEqual(input, {
                  kind: "codex_thread_session",
                  thread_id: "created",
                  expected_execution_host_id: "remote",
                });
                return codexLinkedRootSessionFixture({
                  threadId: "created",
                  sessionId: "session",
                  hostId: "remote",
                  threadSource: "subagent",
                  title: "Created",
                });
              }),
          },
        } as unknown as CoreModules["Service"]);
        const test = yield* makeHarness([], core);
        const started = startedThread(thread({ id: "created", threadSource: "subagent" }));
        assert.deepStrictEqual(
          yield* test.admission.decide({
            notification: started,
            threadId: "created",
            hostId: "remote",
          }),
          { _tag: "Admit" },
        );
        assert.strictEqual(reads, 1);
        for (let index = 0; index < 30; index++)
          assert.deepStrictEqual(
            yield* test.admission.decide({
              notification: delta("created"),
              threadId: "created",
              hostId: "remote",
            }),
            { _tag: "Admit" },
          );
        assert.strictEqual(reads, 1);
      }),
  );

  it.effect("suppresses structured-title and non-sidebar helpers before visible projection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const trace: string[] = [];
        const { admission, internalThreads } = yield* makeHarness(trace);
        const titleLease = yield* Scope.make();
        yield* internalThreads
          .leaseStructuredTitle("title-helper")
          .pipe(Effect.provideService(Scope.Scope, titleLease));

        assert.deepEqual(
          yield* admission.decide({
            notification: startedThread(
              thread({
                id: "title-helper",
                ephemeral: true,
                threadSource: "system",
              }),
            ),
            threadId: "title-helper",
          }),
          { _tag: "Drop", reason: "internal-thread", threadId: "title-helper" },
        );
        yield* Scope.close(titleLease, Exit.void);
        assert.strictEqual(
          (yield* admission.decide({
            notification: delta("title-helper"),
            threadId: "title-helper",
          }))._tag,
          "Drop",
        );

        assert.strictEqual(
          (yield* admission.decide({
            notification: startedThread(thread({ id: "system-helper", threadSource: "system" })),
            threadId: "system-helper",
          }))._tag,
          "Drop",
        );
      }),
    ),
  );

  it.effect(
    "keeps historical child observation passive while preserving selected history deltas",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const trace: string[] = [];
          const { admission, subagents } = yield* makeHarness(trace);
          const child = thread({
            id: "child",
            parentThreadId: "parent",
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: "parent",
                  depth: 1,
                  agent_path: null,
                  agent_nickname: "worker",
                  agent_role: null,
                },
              },
            },
          });

          assert.strictEqual(
            (yield* admission.decide({ notification: startedThread(child), threadId: "child" }))
              ._tag,
            "Admit",
          );
          assert.strictEqual(
            (yield* admission.decide({ notification: delta("child"), threadId: "child" }))._tag,
            "Drop",
          );
          assert.strictEqual(
            (yield* admission.decide({
              notification: startedTurn("child", "child-turn"),
              threadId: "child",
            }))._tag,
            "Admit",
          );
          assert.deepEqual(trace, ["subagent:observe:child", "authority:observe:child:child-turn"]);

          yield* subagents.hydrateSelected({ rootThreadId: "parent", threadId: "child" });
          assert.strictEqual(
            (yield* admission.decide({ notification: delta("child"), threadId: "child" }))._tag,
            "Admit",
          );
        }),
      ),
  );

  it.effect("binds submit presentation only when notification user-message identity matches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { admission, presentation } = yield* makeHarness([]);
        const target = { kind: "thread", threadId: "origin-thread" } as const;
        const ticket = yield* presentation.capture(11, {
          target,
          presentation: testSubmitPresentation,
        });
        const claim = yield* presentation.claim(ticket, target, "origin-message");
        const launch = yield* presentation.begin(claim, target.threadId);
        yield* admission.decide({
          notification: startedTurn(target.threadId, "accepted-turn"),
          threadId: target.threadId,
        });
        assert.isNull(presentation.read(target.threadId, "accepted-turn"));
        yield* admission.decide({
          notification: {
            method: "item/started",
            params: {
              threadId: target.threadId,
              turnId: "accepted-turn",
              startedAtMs: 1,
              item: {
                type: "userMessage",
                id: "user-item",
                clientId: "origin-message",
                content: [],
              },
            },
          },
          threadId: target.threadId,
        });
        assert.equal(
          presentation.read(target.threadId, "accepted-turn")?.windowSessionId,
          "window-a",
        );
        yield* presentation.bind(launch, "accepted-turn");
      }),
    ),
  );

  it.effect("cancels reminders only for live person-authored native messages", () =>
    Effect.gen(function* () {
      const accepted: string[] = [];
      const core = {
        workspace: {
          read: () =>
            Effect.succeed(
              codexLinkedRootSessionFixture({
                threadId: "chat-thread",
                sessionId: "chat",
                hostId: "remote",
              }),
            ),
          apply: (input: { intent: { intent: { message_id: string } } }) =>
            Effect.sync(() => {
              accepted.push(input.intent.intent.message_id);
              return {};
            }),
        },
      } as unknown as CoreModules["Service"];
      const { admission } = yield* makeHarness([], core);
      const send = (id: string, text: string) =>
        admission.decide({
          hostId: "remote",
          threadId: "chat-thread",
          notification: {
            method: "item/started",
            params: {
              threadId: "chat-thread",
              turnId: "turn",
              startedAtMs: 1,
              item: {
                type: "userMessage",
                id,
                clientId: id,
                content: [{ type: "text", text, text_elements: [] }],
              },
            },
          },
        });
      yield* send("person", "Continue here");
      yield* send(
        "agent",
        "<codex_delegation><source_thread_id>agent</source_thread_id><input>Update</input></codex_delegation>",
      );
      yield* admission.decide({
        hostId: "remote",
        threadId: "chat-thread",
        notification: {
          method: "item/started",
          params: {
            threadId: "chat-thread",
            turnId: "turn",
            startedAtMs: 1,
            item: {
              type: "userMessage",
              id: "agent-with-attachment",
              clientId: "agent-with-attachment",
              content: [
                {
                  type: "text",
                  text: "<codex_delegation><source_thread_id>agent</source_thread_id><input>Update</input></codex_delegation>",
                  text_elements: [],
                },
                { type: "text", text: "Attached file context", text_elements: [] },
              ],
            },
          },
        },
      });
      yield* send("automatic", "<realtime_delegation><input>Update</input></realtime_delegation>");
      assert.deepEqual(accepted, ["person"]);
    }),
  );
});
