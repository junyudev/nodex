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
import { createCodexCanonicalConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
  AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
  buildAgentActivityV2CorpusThread,
} from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";

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
    readonly appliedThreadStartedTurns: (readonly unknown[])[];
    readonly appliedTurnStartedItems: (readonly unknown[])[];
    readonly protocol: CodexApplicationProtocol["Service"];
    readonly executedDynamicTools: string[];
    readonly threadStarts: ThreadCreationRuntime["Service"];
    readonly autoResolution: CodexUserInputAutoResolution["Service"];
  }) => Effect.Effect<A, E>,
  options: { readonly streamRole?: "owner" | "follower" } = {},
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
            Layer.succeed(CodexApplicationProtocol, protocol),
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
      appliedThreadStartedTurns,
      appliedTurnStartedItems,
      inbox,
      conversations,
      protocol,
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
      conversations.entity("thread-retired");

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
