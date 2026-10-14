import { CodexRealtimeVoice } from "./CodexRealtimeVoice";
import { CodexResumeIngress, make as makeResumeIngress } from "./CodexResumeIngress";
import { assert, it } from "@effect/vitest";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { CodexAppServerNoResponse } from "@nodex/effect-codex-app-server/protocol";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  CodexApplicationRequestInbox,
  make as makeInbox,
} from "../codex-runtime/CodexApplicationRequestInbox";
import {
  CodexApplicationEventHub,
  type CodexApplicationEvent,
  make as makeApplicationEvents,
} from "./CodexApplicationEventHub";
import { CodexAppProtocolTools } from "./CodexAppProtocolTools";
import { CodexAutomationInbox } from "./CodexAutomationInbox";
import {
  CodexOneShotServerRequests,
  live as oneShotServerRequestsLive,
} from "./CodexOneShotServerRequests";
import {
  CodexPendingServerRequestRuntime,
  make as makePending,
} from "./CodexPendingServerRequestRuntime";
import { CodexNotificationAdmission } from "./CodexNotificationAdmission";
import { CodexProtocolNotificationEffects } from "./CodexProtocolNotificationEffects";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import {
  CodexRendererPresentationRegistry,
  make as makeRendererRegistry,
} from "./CodexRendererPresentationRegistry";
import {
  CodexUserInputAutoResolution,
  make as makeAutoResolution,
} from "./CodexUserInputAutoResolution";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";
import { CodexApplicationProtocol, make as makeProtocol } from "./CodexApplicationProtocol";
import { live as protocolIngressLive } from "./CodexProtocolIngress";
import {
  ThreadCreationRuntime,
  make as makeThreadStartNotificationGate,
} from "./ThreadCreationRuntime";
import { NodexAgentProtocolTools } from "../nodex-agent-application/NodexAgentProtocolTools";
import { MainShutdown, layer as mainShutdownLayer } from "../app/MainShutdown";
import { layer as callbacksLayer } from "../app/ScopedCallbackRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexConversationArchive } from "./CodexConversationArchive";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexServerRequestResponses } from "./CodexServerRequestResponses";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { ConversationCommands, live as commandsLive } from "./ConversationCommands";
import {
  createCodexCanonicalConversationState,
  createCodexCanonicalHydratedConversationState,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
  AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
  buildAgentActivityV2CorpusThread,
} from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";

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

const userInputParams = (threadId: string) => ({
  isBlocking: true,
  itemId: `item-${threadId}`,
  questions: [
    {
      id: "answer",
      header: "Answer",
      question: "Continue?",
      isOther: false,
      isSecret: false,
      options: [
        { label: "Yes", description: "Continue" },
        { label: "No", description: "Stop" },
      ],
    },
  ],
  threadId,
  turnId: `turn-${threadId}`,
});

const directDynamicToolParams = (threadId: string) => ({
  threadId,
  turnId: `turn-${threadId}`,
  callId: `call-${threadId}`,
  namespace: "example_app",
  tool: "example_step",
  arguments: { step: "complete" },
});

const browserOriginAutoAcceptParams = {
  threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
  turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
  serverName: "browser-use",
  mode: "form" as const,
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    connector_id: "browser-use",
    tool_name: "access_browser_origin",
    tool_params: { origin: "https://example.com" },
  },
  message: "Allow browser origin",
  requestedSchema: { type: "object" as const, properties: {} },
};

const browserOriginAutoAcceptState = () =>
  createCodexCanonicalConversationState(buildAgentActivityV2CorpusThread([]), {
    hostId: "local",
    turnParamsById: {
      [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: {
        threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
        input: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
        model: "fixture-model",
        cwd: "/workspace/project",
        attachments: [],
        effort: "high",
        summary: "none",
        personality: null,
        outputSchema: null,
        collaborationMode: null,
      },
    },
  });

const withProtocol = <A, E>(
  run: (services: {
    readonly inbox: CodexApplicationRequestInbox["Service"];
    readonly conversations: ConversationEntityMap["Service"];
    readonly publishedEvents: CodexApplicationEvent[];
    readonly appliedNotifications: string[];
    readonly observedNotifications: string[];
    readonly realtimeControls: { source: unknown; notification: unknown }[];
    readonly appliedThreadStartedTurns: (readonly unknown[])[];
    readonly appliedTurnStartedItems: (readonly unknown[])[];
    readonly protocol: CodexApplicationProtocol["Service"];
    readonly commands: ConversationCommands["Service"];
    readonly deletedThreads: string[];
    readonly executedDynamicTools: string[];
    readonly threadStarts: ThreadCreationRuntime["Service"];
    readonly autoResolution: CodexUserInputAutoResolution["Service"];
  }) => Effect.Effect<A, E>,
  options: {
    readonly archive?: Effect.Effect<boolean>;
    readonly deleteArchived?: Effect.Effect<boolean>;
    readonly streamRole?: "owner" | "follower";
    readonly archivedCleanup?: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
  } = {},
) =>
  Effect.gen(function* () {
    const rootScope = yield* Scope.make();
    const shutdownContext = yield* Layer.buildWithScope(mainShutdownLayer, rootScope);
    const shutdown = Context.get(shutdownContext, MainShutdown);
    const nativeInbox = yield* makeInbox.pipe(Effect.provideService(Scope.Scope, rootScope));
    let activeGeneration = 0;
    const inbox = CodexApplicationRequestInbox.of({
      ...nativeInbox,
      openGeneration: (hostId, generation) =>
        Effect.suspend(() => {
          activeGeneration = generation;
          return nativeInbox.openGeneration(hostId, generation);
        }),
    });
    const conversationContext = yield* Layer.buildWithScope(conversationRuntimeMapLive, rootScope);
    const conversations = Context.get(conversationContext, ConversationEntityMap);
    const deletedThreads: string[] = [];
    const realtimeControls: { source: unknown; notification: unknown }[] = [];
    const commandContext = yield* Layer.buildWithScope(
      commandsLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            callbacksLayer,
            Layer.succeed(ConversationEntityMap, conversations),
            Layer.succeed(CodexConversationArchive, {
              archive: () => options.archive ?? Effect.succeed(true),
              deleteArchived: (threadId) =>
                Effect.sync(() => {
                  deletedThreads.push(threadId);
                }).pipe(Effect.andThen(options.deleteArchived ?? Effect.succeed(true))),
              unarchive: () => Effect.succeed(null),
            }),
            Layer.succeed(CodexGateway, {} as CodexGateway["Service"]),
            Layer.succeed(
              CodexConversationProjection,
              {} as CodexConversationProjection["Service"],
            ),
            Layer.succeed(
              CodexServerRequestResponses,
              {} as CodexServerRequestResponses["Service"],
            ),
            Layer.succeed(CodexSubagentDirectory, {} as CodexSubagentDirectory["Service"]),
            Layer.succeed(CodexThreadDirectory, {} as CodexThreadDirectory["Service"]),
            Layer.succeed(CodexThreadGoalRuntime, {} as CodexThreadGoalRuntime["Service"]),
          ),
        ),
      ),
      rootScope,
    );
    const commands = Context.get(commandContext, ConversationCommands);
    const applicationEvents = yield* makeApplicationEvents.pipe(
      Effect.provideService(Scope.Scope, rootScope),
    );
    const publishedEvents: CodexApplicationEvent[] = [];
    const observedApplicationEvents = CodexApplicationEventHub.of({
      ...applicationEvents,
      publish: (event) => {
        publishedEvents.push(event);
        applicationEvents.publish(event);
      },
    });
    const oneShotContext = yield* Layer.buildWithScope(oneShotServerRequestsLive, rootScope);
    const oneShot = Context.get(oneShotContext, CodexOneShotServerRequests);
    const rendererRegistry = yield* makeRendererRegistry.pipe(
      Effect.provideService(Scope.Scope, rootScope),
    );
    const autoResolution = yield* makeAutoResolution.pipe(
      Effect.provideService(CodexRendererPresentationRegistry, rendererRegistry),
      Effect.provideService(Scope.Scope, rootScope),
    );
    const pending = yield* makePending({
      abandon: (_threadId, _requestId, occurrenceToken) =>
        inbox.settleOccurrenceToken(occurrenceToken, { kind: "abandon" }),
      respond: (_threadId, _requestId, occurrenceToken, response) =>
        inbox.settleOccurrenceToken(occurrenceToken, { kind: "result", value: response }),
      reject: (_threadId, requestId, occurrenceToken, cause) =>
        inbox.settleOccurrenceToken(occurrenceToken, {
          kind: "error",
          error: CodexAppServerRequestError.internalError(
            "Codex application request failed",
            undefined,
            { operation: "handle-request", requestId: String(requestId), cause },
          ),
        }),
    }).pipe(Effect.provideService(Scope.Scope, rootScope));
    const automationInbox = CodexAutomationInbox.of({
      create: () => Effect.succeed({ items: [] }),
    });
    const executedDynamicTools: string[] = [];
    const nodexAgentTools = NodexAgentProtocolTools.of({
      execute: (params) =>
        Effect.sync(() => {
          executedDynamicTools.push(`nodex:${params.tool}`);
          return {
            success: true,
            contentItems: [{ type: "inputText" as const, text: params.tool }],
          };
        }),
    });
    const codexAppTools = CodexAppProtocolTools.of({
      execute: (params) =>
        Effect.sync(() => {
          executedDynamicTools.push(`app:${params.tool}`);
          return {
            success: true,
            contentItems: [{ type: "inputText" as const, text: params.tool }],
          };
        }),
      respond: () => Effect.succeed(null),
    });
    const appliedNotifications: string[] = [];
    const observedNotifications: string[] = [];
    const appliedThreadStartedTurns: (readonly unknown[])[] = [];
    const appliedTurnStartedItems: (readonly unknown[])[] = [];
    const notificationEffects = CodexProtocolNotificationEffects.of({
      apply: ({ notification }) =>
        Effect.sync(() => {
          appliedNotifications.push(notification.method);
          if (notification.method === "thread/started") {
            appliedThreadStartedTurns.push(notification.params.thread.turns);
          }
          if (notification.method === "turn/started") {
            appliedTurnStartedItems.push(notification.params.turn.items);
          }
          if (notification.method !== "serverRequest/resolved") return;
          const entries = pending.takeAll(
            "user-input",
            notification.params.requestId,
            (entry) => entry.threadId === notification.params.threadId,
          );
          for (const entry of entries) pending.complete(entry, CodexAppServerNoResponse);
        }).pipe(
          Effect.andThen(
            notification.method === "thread/archived" && options.archivedCleanup
              ? Deferred.succeed(options.archivedCleanup.entered, undefined).pipe(
                  Effect.andThen(Deferred.await(options.archivedCleanup.release)),
                )
              : Effect.void,
          ),
          Effect.as(
            notification.method === "thread/archived" || notification.method === "thread/deleted"
              ? ("retire" as const)
              : ("retain" as const),
          ),
        ),
    });
    const notificationAdmission = CodexNotificationAdmission.of({
      decide: () => Effect.succeed({ _tag: "Admit" }),
    });
    const threadStarts = yield* makeThreadStartNotificationGate.pipe(
      Effect.provideService(Scope.Scope, rootScope),
    );

    const resumeIngress = yield* makeResumeIngress.pipe(
      Effect.provideService(Scope.Scope, rootScope),
    );
    const protocol = yield* makeProtocol.pipe(
      Effect.provideService(CodexRealtimeVoice, {
        observeNative: (source: unknown, notification: unknown) =>
          Effect.sync(() => {
            realtimeControls.push({ source, notification });
          }),
      } as CodexRealtimeVoice["Service"]),
      Effect.provideService(CodexResumeIngress, resumeIngress),
      Effect.provideService(CodexApplicationEventHub, observedApplicationEvents),
      Effect.provideService(CodexAppProtocolTools, codexAppTools),
      Effect.provideService(CodexApplicationRequestInbox, inbox),
      Effect.provideService(CodexAutomationInbox, automationInbox),
      Effect.provideService(CodexNotificationAdmission, notificationAdmission),
      Effect.provideService(CodexOneShotServerRequests, oneShot),
      Effect.provideService(CodexPendingServerRequestRuntime, pending),
      Effect.provideService(CodexProtocolNotificationEffects, notificationEffects),
      Effect.provideService(CodexMainConversationManagers, {
        current: () => ({
          generation: activeGeneration,
          stream: {
            getRole: () => ({ role: options.streamRole ?? "owner" }),
            shouldHandleDynamicToolCall: () => true,
          },
        }),
      } as unknown as CodexMainConversationManagers["Service"]),
      Effect.provideService(ThreadCreationRuntime, threadStarts),
      Effect.provideService(CodexUserInputAutoResolution, autoResolution),
      Effect.provideService(ConversationEntityMap, conversations),
      Effect.provideService(NodexAgentProtocolTools, nodexAgentTools),
      Effect.provideService(Scope.Scope, rootScope),
    );
    yield* Layer.buildWithScope(
      protocolIngressLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CodexApplicationProtocol, {
              ...protocol,
              observe: (occurrence) =>
                protocol.observe(occurrence).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      observedNotifications.push(occurrence.method);
                    }),
                  ),
                ),
            }),
            Layer.succeed(CodexApplicationRequestInbox, inbox),
            Layer.succeed(ThreadCreationRuntime, threadStarts),
            Layer.succeed(MainShutdown, shutdown),
          ),
        ),
      ),
      rootScope,
    );

    const result = yield* run({
      publishedEvents,
      autoResolution,
      appliedNotifications,
      observedNotifications,
      realtimeControls,
      appliedThreadStartedTurns,
      appliedTurnStartedItems,
      inbox,
      conversations,
      protocol,
      commands,
      deletedThreads,
      executedDynamicTools,
      threadStarts,
    }).pipe(Effect.provideService(Scope.Scope, rootScope));
    yield* Scope.close(rootScope, Exit.void);
    return result;
  });

it.effect("replays bounded lifecycle metadata after its local materialization commits", () =>
  withProtocol(
    ({
      publishedEvents,
      appliedNotifications,
      appliedThreadStartedTurns,
      appliedTurnStartedItems,
      inbox,
      threadStarts,
    }) =>
      Effect.gen(function* () {
        const generationScope = yield* Scope.make();
        yield* inbox
          .openGeneration("local", 8)
          .pipe(Effect.provideService(Scope.Scope, generationScope));
        const commit = yield* Deferred.make<string>();
        const materialization = yield* threadStarts
          .materialize("local", 8, Deferred.await(commit), (threadId) => threadId)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const poisonTurns = [
          {
            id: "poison-turn",
            items: [
              {
                id: "poison-item",
                type: "agentMessage",
                text: "x".repeat(2 * 1024 * 1024 + 1),
              },
            ],
          },
        ];
        yield* inbox.publishNotification({
          hostId: "local",
          generation: 8,
          protocol: "generated",
          method: "thread/started",
          params: {
            thread: {
              id: "thread-gated",
              sessionId: "session-thread-gated",
              preview: "",
              ephemeral: false,
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 1,
              status: { type: "idle" },
              cwd: "/repo",
              cliVersion: "test",
              source: "unknown",
              turns: poisonTurns,
            },
          },
        });
        const boundedTurnItems = [
          {
            questions: null,
            id: "giant-turn-item",
            type: "agentMessage",
            text: "bounded live output",
            phase: null,
            memoryCitation: null,
            delivery: null,
          },
        ];
        yield* inbox.publishNotification({
          hostId: "local",
          generation: 8,
          protocol: "generated",
          method: "turn/started",
          params: {
            threadId: "thread-gated",
            turn: {
              rootTurnId: null,
              id: "turn-gated",
              items: boundedTurnItems,
              itemsView: "full",
              status: "inProgress",
              error: null,
              startedAt: 1,
              completedAt: null,
              durationMs: null,
            },
          },
        });
        yield* Effect.yieldNow;
        for (
          let attempt = 0;
          attempt < 1_000 &&
          !publishedEvents.some(
            (event) => event.kind === "hostMessage" && event.value.type === "nativeNotification",
          );
          attempt += 1
        )
          yield* Effect.yieldNow;
        const rawThreadStart = publishedEvents.find(
          (event) =>
            event.kind === "hostMessage" &&
            event.value.type === "nativeNotification" &&
            event.value.notification.method === "thread/started",
        );
        assert.ok(
          rawThreadStart?.kind === "hostMessage" &&
            rawThreadStart.value.type === "nativeNotification" &&
            rawThreadStart.value.notification.method === "thread/started",
        );
        assert.strictEqual(rawThreadStart.value.generation, 8);
        assert.deepEqual<readonly unknown[]>(
          rawThreadStart.value.notification.params.thread.turns,
          poisonTurns,
        );
        assert.deepEqual(appliedNotifications, []);
        assert.deepEqual(appliedThreadStartedTurns, []);
        assert.deepEqual(appliedTurnStartedItems, []);

        yield* Deferred.succeed(commit, "thread-gated");
        assert.strictEqual(yield* Fiber.join(materialization), "thread-gated");
        for (let attempt = 0; attempt < 1_000 && appliedNotifications.length < 2; attempt += 1) {
          yield* Effect.yieldNow;
        }
        assert.deepEqual(appliedNotifications, ["thread/started", "turn/started"]);
        assert.deepEqual(appliedThreadStartedTurns, [[]]);
        assert.notStrictEqual(appliedThreadStartedTurns[0], poisonTurns);
        const marker = appliedTurnStartedItems[0]?.[0] as
          | {
              readonly id?: unknown;
              readonly type?: unknown;
              readonly text?: unknown;
              readonly phase?: unknown;
              readonly memoryCitation?: unknown;
            }
          | undefined;
        assert.strictEqual(marker?.id, "giant-turn-item");
        assert.strictEqual(marker?.type, "agentMessage");
        assert.strictEqual(marker?.text, "bounded live output");
        assert.strictEqual(marker?.phase, null);
        assert.strictEqual(marker?.memoryCitation, null);
        assert.strictEqual(appliedTurnStartedItems[0], boundedTurnItems);
        yield* Scope.close(generationScope, Exit.void);
      }),
  ),
);

it.effect(
  "withdraws a generation before a blocked Thread command can mutate application state",
  () =>
    withProtocol(({ inbox, conversations, protocol }) =>
      Effect.gen(function* () {
        const generationScope = yield* Scope.make();
        const generation = yield* inbox
          .openGeneration("local", 1)
          .pipe(Effect.provideService(Scope.Scope, generationScope));
        assert.isTrue(protocol.beginResume("thread-a"));

        yield* generation.admit({
          requestId: "blocked",
          protocol: "generated",
          method: "item/tool/requestUserInput",
          params: userInputParams("thread-a"),
        });
        yield* Effect.yieldNow;
        yield* Scope.close(generationScope, Exit.void);
        yield* protocol.releaseResume("thread-a");

        assert.deepEqual(conversations.entity("thread-a").readServerRequests(), []);
      }),
    ),
);

it.effect("routes remote interactive request notifications through their execution host", () =>
  withProtocol(({ inbox, publishedEvents }) =>
    Effect.gen(function* () {
      const generationScope = yield* Scope.make();
      const generation = yield* inbox
        .openGeneration("ssh:builder", 4)
        .pipe(Effect.provideService(Scope.Scope, generationScope));

      yield* generation.admit({
        requestId: "remote-input",
        protocol: "generated",
        method: "item/tool/requestUserInput",
        params: userInputParams("remote-thread"),
      });
      for (
        let index = 0;
        index < 20 && !publishedEvents.some((event) => event.kind === "threadNotification");
        index += 1
      ) {
        yield* Effect.yieldNow;
      }

      const notification = publishedEvents.find(
        (event) =>
          event.kind === "threadNotification" && event.value.type === "user-input-requested",
      );
      assert.isDefined(notification);
      if (
        notification?.kind === "threadNotification" &&
        notification.value.type === "user-input-requested"
      ) {
        assert.strictEqual(notification.value.hostId, "ssh:builder");
        assert.strictEqual(notification.value.conversation.conversationId, "remote-thread");
      }
      yield* Scope.close(generationScope, Exit.void);
    }),
  ),
);

it.effect("retires the exact Conversation Entity after a terminal notification commits", () =>
  withProtocol(({ inbox, conversations }) =>
    Effect.gen(function* () {
      const generationScope = yield* Scope.make();
      yield* inbox
        .openGeneration("local", 9)
        .pipe(Effect.provideService(Scope.Scope, generationScope));
      conversations
        .entity("thread-retired")
        .installFollowerCanonicalState(liveNativeState("thread-retired", "local"));

      yield* inbox.publishNotification({
        hostId: "local",
        generation: 9,
        protocol: "generated",
        method: "thread/archived",
        params: { threadId: "thread-retired" },
      });
      while (conversations.current("thread-retired") !== null) yield* Effect.yieldNow;

      assert.isNull(conversations.current("thread-retired"));
      yield* Scope.close(generationScope, Exit.void);
    }),
  ),
);

it.effect("seals an archived notification before queued commands can enter the retired lane", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* withProtocol(
      ({ inbox, conversations }) =>
        Effect.gen(function* () {
          const generationScope = yield* Scope.make();
          yield* inbox
            .openGeneration("local", 9)
            .pipe(Effect.provideService(Scope.Scope, generationScope));
          conversations
            .entity("thread-retired")
            .installFollowerCanonicalState(liveNativeState("thread-retired", "local"));
          const activeEntered = yield* Deferred.make<void>();
          const active = yield* conversations
            .admitExecution(
              "thread-retired",
              { hostId: "local", generation: 9 },
              Deferred.succeed(activeEntered, undefined).pipe(Effect.andThen(Effect.never)),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(activeEntered);
          yield* inbox.publishNotification({
            hostId: "local",
            generation: 9,
            protocol: "generated",
            method: "thread/archived",
            params: { threadId: "thread-retired" },
          });
          yield* Deferred.await(entered);
          let queuedBodyEntered = false;
          const queued = yield* conversations
            .runCommand(
              "thread-retired",
              Effect.sync(() => {
                queuedBodyEntered = true;
              }),
            )
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          assert.isTrue(Exit.isFailure(yield* Fiber.await(active)));
          assert.isTrue(Exit.isFailure(yield* Fiber.await(queued)));
          assert.isFalse(queuedBodyEntered);
          while (conversations.current("thread-retired") !== null) yield* Effect.yieldNow;
          yield* conversations.runTerminalCommand("thread-retired", Effect.succeed(true), Boolean);
          assert.isNull(conversations.current("thread-retired"));
          yield* Scope.close(generationScope, Exit.void);
        }),
      { archivedCleanup: { entered, release } },
    );
  }),
);

it.effect("a delayed Thread-start release cannot consume or retire a replacement generation", () =>
  withProtocol(
    ({
      conversations,
      protocol,
      inbox,
      threadStarts,
      observedNotifications,
      appliedNotifications,
    }) =>
      Effect.gen(function* () {
        const generationScope = yield* Scope.make();
        yield* inbox
          .openGeneration("local", 9)
          .pipe(Effect.provideService(Scope.Scope, generationScope));
        const admission = threadStarts.open("local", 9);
        const original = conversations.entity("thread-delayed-release");
        yield* inbox.publishNotification({
          hostId: "local",
          generation: 9,
          protocol: "generated",
          method: "thread/started",
          params: {
            thread: {
              ...buildAgentActivityV2CorpusThread(),
              id: "thread-delayed-release",
              turns: [],
            },
          },
        });
        yield* inbox.publishNotification({
          hostId: "local",
          generation: 9,
          protocol: "generated",
          method: "thread/archived",
          params: { threadId: "thread-delayed-release" },
        });
        while (observedNotifications.length < 2) yield* Effect.yieldNow;
        assert.deepEqual(appliedNotifications, []);
        const release = protocol.releaseThreadStart({
          threadId: "thread-delayed-release",
          hostId: "local",
          generation: 9,
        });
        yield* conversations.retire("thread-delayed-release");
        const replacement = conversations.entity("thread-delayed-release");
        assert.notStrictEqual(replacement.generation, original.generation);
        yield* release;
        assert.strictEqual(conversations.current("thread-delayed-release"), replacement);
        assert.deepEqual(appliedNotifications, []);
        assert.deepEqual(
          original.clearBufferedEvents().map((event) => event.method),
          ["thread/started", "thread/archived"],
        );
        yield* conversations.runCommand("thread-delayed-release", Effect.void);
        yield* admission.close();
        yield* Scope.close(generationScope, Exit.void);
      }),
  ),
);

it.effect("a late archive notification cannot cancel the next archived deletion", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* withProtocol(
      ({ inbox, conversations, commands, deletedThreads }) =>
        Effect.gen(function* () {
          const generationScope = yield* Scope.make();
          yield* inbox
            .openGeneration("local", 9)
            .pipe(Effect.provideService(Scope.Scope, generationScope));
          const original = conversations.entity("thread-archive-delete");
          assert.isTrue(yield* commands.archive("thread-archive-delete"));
          assert.isNull(conversations.current("thread-archive-delete"));
          yield* inbox.publishNotification({
            hostId: "local",
            generation: 9,
            protocol: "generated",
            method: "thread/archived",
            params: { threadId: "thread-archive-delete" },
          });
          yield* Deferred.await(entered);
          const deleting = yield* commands
            .deleteArchived("thread-archive-delete")
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          assert.isTrue(yield* Fiber.join(deleting));
          assert.deepEqual(deletedThreads, ["thread-archive-delete"]);
          assert.isNull(conversations.current("thread-archive-delete"));
          assert.notStrictEqual(
            original.generation,
            conversations.entity("thread-archive-delete").generation,
          );
          yield* Scope.close(generationScope, Exit.void);
        }),
      { archivedCleanup: { entered, release } },
    );
  }),
);

it.effect(
  "native archive observation cannot interrupt its admitted command's remaining Core work",
  () =>
    Effect.gen(function* () {
      const coreEntered = yield* Deferred.make<void>();
      const finishCore = yield* Deferred.make<void>();
      yield* withProtocol(
        ({ inbox, conversations, commands, observedNotifications }) =>
          Effect.gen(function* () {
            const generationScope = yield* Scope.make();
            yield* inbox
              .openGeneration("local", 9)
              .pipe(Effect.provideService(Scope.Scope, generationScope));
            const entity = conversations.entity("thread-core-work");
            entity.installFollowerCanonicalState(liveNativeState("thread-core-work", "local"));
            const archiving = yield* commands.archive("thread-core-work").pipe(Effect.forkChild);
            yield* Deferred.await(coreEntered);
            yield* inbox.publishNotification({
              hostId: "local",
              generation: 9,
              protocol: "generated",
              method: "thread/archived",
              params: { threadId: "thread-core-work" },
            });
            for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
            assert.isFalse(observedNotifications.includes("thread/archived"));
            assert.strictEqual(conversations.current("thread-core-work"), entity);
            yield* Deferred.succeed(finishCore, undefined);
            assert.isTrue(yield* Fiber.join(archiving));
            while (!observedNotifications.includes("thread/archived")) yield* Effect.yieldNow;
            assert.isNull(conversations.current("thread-core-work"));
            yield* Scope.close(generationScope, Exit.void);
          }),
        {
          archive: Deferred.succeed(coreEntered, undefined).pipe(
            Effect.andThen(Deferred.await(finishCore)),
            Effect.as(true),
          ),
        },
      );
    }),
);

it.effect("a late archive after deletion admission preserves that deletion and applies once", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* withProtocol(
      ({ inbox, conversations, commands, observedNotifications, appliedNotifications }) =>
        Effect.gen(function* () {
          const generationScope = yield* Scope.make();
          yield* inbox
            .openGeneration("local", 9)
            .pipe(Effect.provideService(Scope.Scope, generationScope));
          conversations.entity("thread-admitted-delete");
          assert.isTrue(yield* commands.archive("thread-admitted-delete"));
          const deleting = yield* commands
            .deleteArchived("thread-admitted-delete")
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* inbox.publishNotification({
            hostId: "local",
            generation: 9,
            protocol: "generated",
            method: "thread/archived",
            params: { threadId: "thread-admitted-delete" },
          });
          for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
          assert.deepEqual(appliedNotifications, []);
          yield* Deferred.succeed(release, undefined);
          assert.isTrue(yield* Fiber.join(deleting));
          while (!observedNotifications.includes("thread/archived")) yield* Effect.yieldNow;
          assert.deepEqual(appliedNotifications, ["thread/archived"]);
          assert.isNull(conversations.current("thread-admitted-delete"));
          yield* conversations.runCommand("thread-admitted-delete", Effect.void);
          yield* Scope.close(generationScope, Exit.void);
        }),
      {
        deleteArchived: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(true),
        ),
      },
    );
  }),
);

it.effect("a resumed native lifecycle remains closable after a late utility-only observation", () =>
  withProtocol(({ inbox, conversations, commands, observedNotifications }) =>
    Effect.gen(function* () {
      const generationScope = yield* Scope.make();
      yield* inbox
        .openGeneration("local", 9)
        .pipe(Effect.provideService(Scope.Scope, generationScope));
      assert.isTrue(yield* commands.archive("thread-reopen"));
      const utility = conversations.entity("thread-reopen");
      const publish = () =>
        inbox.publishNotification({
          hostId: "local",
          generation: 9,
          protocol: "generated",
          method: "thread/archived",
          params: { threadId: "thread-reopen" },
        });
      yield* publish();
      while (observedNotifications.length < 1) yield* Effect.yieldNow;
      assert.strictEqual(conversations.current("thread-reopen"), utility);
      utility.installFollowerCanonicalState(liveNativeState("thread-reopen", "local"));
      yield* publish();
      while (observedNotifications.length < 2) yield* Effect.yieldNow;
      assert.isNull(conversations.current("thread-reopen"));
      yield* Scope.close(generationScope, Exit.void);
    }),
  ),
);

it.effect.each([
  { streamRole: "owner" as const, expectedKind: "result" as const },
  { streamRole: "follower" as const, expectedKind: "abandon" as const },
])(
  "conditionally auto-accepts browser-origin MCP elicitation as $streamRole",
  ({ streamRole, expectedKind }) =>
    withProtocol(
      ({ inbox, conversations }) =>
        Effect.gen(function* () {
          const generationScope = yield* Scope.make();
          const generation = yield* inbox
            .openGeneration("local", 21)
            .pipe(Effect.provideService(Scope.Scope, generationScope));
          conversations
            .entity(AGENT_ACTIVITY_V2_CORPUS_THREAD_ID)
            .installFollowerCanonicalState(browserOriginAutoAcceptState());
          const settled = yield* generation.settlements.pipe(Stream.runHead, Effect.forkChild);
          yield* generation.admit({
            requestId: `browser-auto-${streamRole}`,
            protocol: "generated",
            method: "mcpServer/elicitation/request",
            params: browserOriginAutoAcceptParams,
          });

          const settlement = yield* Fiber.join(settled);
          assert.strictEqual(settlement._tag, "Some");
          if (settlement._tag === "Some") {
            assert.strictEqual(settlement.value.outcome.kind, expectedKind);
            if (settlement.value.outcome.kind === "result") {
              assert.deepEqual(settlement.value.outcome.value, {
                action: "accept",
                content: {},
                _meta: null,
              });
            }
          }
          assert.deepEqual(
            conversations.entity(AGENT_ACTIVITY_V2_CORPUS_THREAD_ID).readServerRequests(),
            [],
          );
          yield* Scope.close(generationScope, Exit.void);
        }),
      { streamRole },
    ),
);

it.effect("declines the private MCP user-verification mode before canonical storage", () =>
  withProtocol(({ inbox, conversations }) =>
    Effect.gen(function* () {
      const generationScope = yield* Scope.make();
      const generation = yield* inbox
        .openGeneration("local", 22)
        .pipe(Effect.provideService(Scope.Scope, generationScope));
      const settled = yield* generation.settlements.pipe(Stream.runHead, Effect.forkChild);
      yield* generation.admit({
        requestId: "private-user-verification",
        protocol: "extension",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-private-verification",
          turnId: "turn-private-verification",
          serverName: "browser-use",
          mode: "openai/userVerification",
          _meta: { verificationUrl: "https://example.com" },
        },
      });

      const settlement = yield* Fiber.join(settled);
      assert.strictEqual(settlement._tag, "Some");
      if (settlement._tag === "Some") {
        assert.deepEqual(settlement.value.outcome, {
          kind: "result",
          value: { action: "decline", content: null, _meta: null },
        });
      }
      assert.deepEqual(
        conversations.entity("thread-private-verification").readServerRequests(),
        [],
      );
      yield* Scope.close(generationScope, Exit.void);
    }),
  ),
);

it.effect.each([
  { autoResolutionMs: 5_000, tracked: true },
  { autoResolutionMs: 300_000, tracked: true },
  { autoResolutionMs: 4_999, tracked: false },
  { autoResolutionMs: 300_001, tracked: false },
  { autoResolutionMs: 5_000.5, tracked: false },
])(
  "tracks MCP auto-resolution only for exact bounded integer metadata",
  ({ autoResolutionMs, tracked }) =>
    withProtocol(({ inbox, autoResolution, conversations }) =>
      Effect.gen(function* () {
        const generationScope = yield* Scope.make();
        const generation = yield* inbox
          .openGeneration("local", 23)
          .pipe(Effect.provideService(Scope.Scope, generationScope));
        const threadId = `thread-mcp-auto-${String(autoResolutionMs).replace(".", "-")}`;
        yield* generation.admit({
          requestId: `mcp-auto-${String(autoResolutionMs)}`,
          protocol: "generated",
          method: "mcpServer/elicitation/request",
          params: {
            threadId,
            turnId: null,
            serverName: "fixture",
            mode: "form",
            _meta: { autoResolutionMs, extra: "allowed" },
            message: "Choose",
            requestedSchema: { type: "object", properties: {} },
          },
        });
        for (
          let attempt = 0;
          attempt < 1_000 && conversations.entity(threadId).readServerRequests().length === 0;
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(conversations.entity(threadId).readServerRequests(), 1);

        const entry = (yield* autoResolution.snapshot).find(
          (candidate) => candidate.conversationId === threadId,
        );
        assert.strictEqual(entry !== undefined, tracked);
        if (tracked) assert.strictEqual(entry?.phase.type, "scheduled");
        yield* Scope.close(generationScope, Exit.void);
      }),
    ),
);

it.effect.each([
  { namespace: "nodex_app", tool: "get_context", message: /native MCP/ },
  { namespace: "codex_app", tool: "create_thread", message: /native MCP/ },
  { namespace: "codex_app", tool: "automation_update", message: /native MCP/ },
  { namespace: "codex_app", tool: "read_thread_terminal", message: /native MCP/ },
  { namespace: "codex_app", tool: "setup_codex_step", message: /unavailable/ },
])("rejects retired local $namespace.$tool before dispatch or renderer storage", (input) =>
  withProtocol(({ inbox, conversations, executedDynamicTools }) =>
    Effect.gen(function* () {
      const generationScope = yield* Scope.make();
      const generation = yield* inbox
        .openGeneration("local", 4)
        .pipe(Effect.provideService(Scope.Scope, generationScope));
      const settled = yield* generation.settlements.pipe(Stream.runHead, Effect.forkChild);
      yield* generation.admit({
        requestId: "retired-call",
        protocol: "generated",
        method: "item/tool/call",
        params: {
          threadId: "thread-a",
          turnId: "turn-a",
          callId: "call-a",
          namespace: input.namespace,
          tool: input.tool,
          arguments: {},
        },
      });

      const settlement = yield* Fiber.join(settled);
      assert.strictEqual(settlement._tag, "Some");
      if (settlement._tag === "Some") {
        const outcome = settlement.value.outcome;
        assert.strictEqual(outcome.kind, "result");
        if (outcome.kind === "result") {
          const result = outcome.value as { success: boolean; contentItems: { text: string }[] };
          assert.isFalse(result.success);
          assert.match(result.contentItems[0]!.text, input.message);
        }
      }
      assert.deepEqual(executedDynamicTools, []);
      assert.deepEqual(conversations.entity("thread-a").readServerRequests(), []);
      yield* Scope.close(generationScope, Exit.void);
    }),
  ),
);

it.effect("lets another Thread respond while the first Thread command lane is occupied", () =>
  withProtocol(({ inbox, conversations }) =>
    Effect.gen(function* () {
      const generationScope = yield* Scope.make();
      const generation = yield* inbox
        .openGeneration("local", 2)
        .pipe(Effect.provideService(Scope.Scope, generationScope));
      const laneEntered = yield* Deferred.make<void>();
      const releaseLane = yield* Deferred.make<void>();
      const blocker = yield* conversations
        .runCommand(
          "thread-a",
          Deferred.succeed(laneEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLane)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(laneEntered);
      yield* generation.admit({
        requestId: "blocked",
        protocol: "generated",
        method: "item/tool/requestUserInput",
        params: userInputParams("thread-a"),
      });
      const responseFiber = yield* generation.settlements.pipe(
        Stream.filter(({ occurrence }) => occurrence.requestId === "fast"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* generation.admit({
        requestId: "fast",
        protocol: "generated",
        method: "item/tool/call",
        params: directDynamicToolParams("thread-b"),
      });

      const response = yield* Fiber.join(responseFiber);
      assert.strictEqual(response._tag, "Some");
      if (response._tag === "Some") {
        assert.deepEqual(response.value.outcome, {
          kind: "result",
          value: {
            success: true,
            contentItems: [{ type: "inputText", text: "example_step" }],
          },
        });
      }
      assert.deepEqual(conversations.entity("thread-a").readServerRequests(), []);
      yield* Deferred.succeed(releaseLane, undefined);
      yield* Fiber.join(blocker);
      yield* Scope.close(generationScope, Exit.void);
    }),
  ),
);

it.effect(
  "leaves current-time responses to the renderer outside a blocked Thread command lane",
  () =>
    withProtocol(({ inbox, conversations, publishedEvents }) =>
      Effect.gen(function* () {
        const generationScope = yield* Scope.make();
        const generation = yield* inbox
          .openGeneration("local", 5)
          .pipe(Effect.provideService(Scope.Scope, generationScope));
        const laneEntered = yield* Deferred.make<void>();
        const releaseLane = yield* Deferred.make<void>();
        const blocker = yield* conversations
          .runCommand(
            "thread-a",
            Deferred.succeed(laneEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseLane)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(laneEntered);
        const settled = yield* generation.settlements.pipe(Stream.runHead, Effect.forkChild);
        const occurrence = yield* generation.admit({
          requestId: "time",
          protocol: "generated",
          method: "currentTime/read",
          params: { threadId: "thread-a" },
        });
        for (let index = 0; index < 20 && publishedEvents.length === 0; index += 1) {
          yield* Effect.yieldNow;
        }

        assert.isUndefined(settled.pollUnsafe());
        const nativeRequests = publishedEvents.filter(
          (event) => event.kind === "hostMessage" && event.value.type === "nativeRequest",
        );
        assert.strictEqual(nativeRequests.length, 1);
        const published = nativeRequests[0];
        assert.isDefined(published);
        if (published?.kind === "hostMessage" && published.value.type === "nativeRequest") {
          assert.strictEqual(published.value.hostId, "local");
          assert.strictEqual(published.value.generation, 5);
          assert.strictEqual(published.value.occurrenceId, occurrence.occurrenceId);
          assert.strictEqual(published.value.occurrenceToken, occurrence.occurrenceToken);
          assert.strictEqual(published.value.request.id, "time");
          assert.strictEqual(published.value.request.method, "currentTime/read");
        }
        assert.isTrue(
          yield* inbox.settle(occurrence, {
            kind: "result",
            value: { currentTimeAt: 123 },
          }),
        );

        const settlement = yield* Fiber.join(settled);
        assert.strictEqual(settlement._tag, "Some");
        if (settlement._tag === "Some") {
          assert.deepEqual(settlement.value.outcome, {
            kind: "result",
            value: { currentTimeAt: 123 },
          });
        }
        yield* Deferred.succeed(releaseLane, undefined);
        yield* Fiber.join(blocker);
        yield* Scope.close(generationScope, Exit.void);
      }),
    ),
);

it.effect("abandons a request after the following resolution notification in the same Thread", () =>
  withProtocol(({ inbox }) =>
    Effect.gen(function* () {
      const generationScope = yield* Scope.make();
      const generation = yield* inbox
        .openGeneration("local", 3)
        .pipe(Effect.provideService(Scope.Scope, generationScope));
      const settled = yield* generation.settlements.pipe(Stream.runHead, Effect.forkChild);
      const request = yield* generation.admit({
        requestId: 73,
        protocol: "generated",
        method: "item/tool/requestUserInput",
        params: userInputParams("thread-a"),
      });
      yield* inbox.publishNotification({
        hostId: "local",
        generation: 3,
        protocol: "generated",
        method: "serverRequest/resolved",
        params: { threadId: "thread-a", requestId: 73 },
      });

      const settlement = yield* Fiber.join(settled);
      assert.strictEqual(settlement._tag, "Some");
      if (settlement._tag === "Some") {
        assert.strictEqual(settlement.value.occurrence, request);
        assert.strictEqual(settlement.value.outcome.kind, "abandon");
      }
      yield* Scope.close(generationScope, Exit.void);
    }),
  ),
);

it.effect("clears an earlier optional request countdown when a blocking question arrives", () =>
  withProtocol(({ inbox, autoResolution }) =>
    Effect.gen(function* () {
      const generationScope = yield* Scope.make();
      const generation = yield* inbox
        .openGeneration("local", 12)
        .pipe(Effect.provideService(Scope.Scope, generationScope));
      yield* generation.admit({
        requestId: "optional",
        protocol: "generated",
        method: "item/tool/requestUserInput",
        params: { ...userInputParams("thread-a"), isBlocking: false },
      });
      while ((yield* autoResolution.snapshot).length === 0) yield* Effect.yieldNow;
      assert.strictEqual((yield* autoResolution.snapshot)[0]?.requestId, "optional");
      yield* generation.admit({
        requestId: "blocking",
        protocol: "generated",
        method: "item/tool/requestUserInput",
        params: userInputParams("thread-a"),
      });
      while ((yield* autoResolution.snapshot).length !== 0) yield* Effect.yieldNow;
      assert.deepEqual(yield* autoResolution.snapshot, []);
      yield* Scope.close(generationScope, Exit.void);
    }),
  ),
);

it.effect(
  "delivers reliable realtime controls and safety completions through the existing occurrence interpreter",
  () =>
    withProtocol(({ inbox, realtimeControls, observedNotifications }) =>
      Effect.gen(function* () {
        const generationScope = yield* Scope.make();
        yield* inbox
          .openGeneration("local", 8)
          .pipe(Effect.provideService(Scope.Scope, generationScope));
        const messages = [
          {
            method: "thread/realtime/started",
            params: { threadId: "voice", realtimeSessionId: "session", version: "v1" },
          },
          { method: "thread/realtime/sdp", params: { threadId: "voice", sdp: "native-answer" } },
          {
            method: "thread/realtime/itemAdded",
            params: {
              threadId: "voice",
              item: {
                type: "handoff_request",
                handoff_id: "native-handoff",
                input_transcript: "work",
              },
            },
          },
          {
            method: "thread/realtime/error",
            params: { threadId: "voice", message: "native-failure" },
          },
          {
            method: "thread/realtime/closed",
            params: { threadId: "voice", reason: "transport_closed" },
          },
          {
            method: "turn/completed",
            params: {
              threadId: "voice",
              turn: {
                ...buildAgentActivityV2CorpusThread([]).turns[0]!,
                status: "failed",
                error: {
                  message: "Blocked",
                  codexErrorInfo: "misalignmentPolicyViolation",
                  additionalDetails: null,
                  misalignment: null,
                },
              },
            },
          },
        ] as const;
        for (const message of messages)
          yield* inbox.publishNotification({
            hostId: "local",
            generation: 8,
            protocol: "generated",
            ...message,
          });
        for (let index = 0; index < 100 && realtimeControls.length < messages.length; index++)
          yield* Effect.yieldNow;
        assert.strictEqual(realtimeControls.length, messages.length);
        assert.deepStrictEqual(
          realtimeControls.map(({ notification }) => notification),
          [...messages],
        );
        assert.deepStrictEqual(
          observedNotifications,
          messages.map(({ method }) => method),
        );
        for (const { source } of realtimeControls) assert.propertyVal(source, "generation", 8);
        yield* Scope.close(generationScope, Exit.void);
      }),
    ),
);
