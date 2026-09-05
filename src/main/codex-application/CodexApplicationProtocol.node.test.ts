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
import {
  CodexRendererConversationCoordinator,
  type CodexRendererConversationCoordinatorService,
} from "./CodexRendererConversationCoordinator";
import {
  CodexRendererConversationRegistry,
  make as makeRendererRegistry,
} from "./CodexRendererConversationRegistry";
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

const coordinator = CodexRendererConversationCoordinator.of({
  forwardNotificationForConversation: () => false,
  forwardServerRequest: () => false,
  clearRequestDelivery: () => undefined,
  reconcileOwnership: () => undefined,
} as unknown as CodexRendererConversationCoordinatorService);

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

const directCodexAppParams = (threadId: string) => ({
  threadId,
  turnId: `turn-${threadId}`,
  callId: `call-${threadId}`,
  namespace: "codex_app",
  tool: "setup_codex_step",
  arguments: { step: "complete" },
});

const withProtocol = <A, E>(
  run: (services: {
    readonly inbox: CodexApplicationRequestInbox["Service"];
    readonly conversations: ConversationEntityMap["Service"];
    readonly appliedNotifications: string[];
    readonly appliedThreadStartedTurns: (readonly unknown[])[];
    readonly appliedTurnStartedItems: (readonly unknown[])[];
    readonly protocol: CodexApplicationProtocol["Service"];
    readonly threadStarts: ThreadCreationRuntime["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const rootScope = yield* Scope.make();
    const shutdownContext = yield* Layer.buildWithScope(mainShutdownLayer, rootScope);
    const shutdown = Context.get(shutdownContext, MainShutdown);
    const inbox = yield* makeInbox.pipe(Effect.provideService(Scope.Scope, rootScope));
    const conversationContext = yield* Layer.buildWithScope(conversationRuntimeMapLive, rootScope);
    const conversations = Context.get(conversationContext, ConversationEntityMap);
    const applicationEvents = yield* makeApplicationEvents.pipe(
      Effect.provideService(Scope.Scope, rootScope),
    );
    const oneShotContext = yield* Layer.buildWithScope(oneShotServerRequestsLive, rootScope);
    const oneShot = Context.get(oneShotContext, CodexOneShotServerRequests);
    const rendererRegistry = yield* makeRendererRegistry().pipe(
      Effect.provideService(Scope.Scope, rootScope),
    );
    const autoResolution = yield* makeAutoResolution.pipe(
      Effect.provideService(CodexRendererConversationRegistry, rendererRegistry),
      Effect.provideService(Scope.Scope, rootScope),
    );
    const pending = yield* makePending({
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
    const nodexAgentTools = NodexAgentProtocolTools.of({
      execute: (params) =>
        Effect.succeed({
          success: true,
          contentItems: [{ type: "inputText", text: params.tool }],
        }),
    });
    const codexAppTools = CodexAppProtocolTools.of({
      execute: (params) =>
        Effect.succeed({
          success: true,
          contentItems: [{ type: "inputText", text: params.tool }],
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

    const protocol = yield* makeProtocol.pipe(
      Effect.provideService(CodexApplicationEventHub, applicationEvents),
      Effect.provideService(CodexAppProtocolTools, codexAppTools),
      Effect.provideService(CodexApplicationRequestInbox, inbox),
      Effect.provideService(CodexAutomationInbox, automationInbox),
      Effect.provideService(CodexNotificationAdmission, notificationAdmission),
      Effect.provideService(CodexOneShotServerRequests, oneShot),
      Effect.provideService(CodexPendingServerRequestRuntime, pending),
      Effect.provideService(CodexProtocolNotificationEffects, notificationEffects),
      Effect.provideService(CodexRendererConversationCoordinator, coordinator),
      Effect.provideService(CodexRendererConversationRegistry, rendererRegistry),
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
      appliedNotifications,
      appliedThreadStartedTurns,
      appliedTurnStartedItems,
      inbox,
      conversations,
      protocol,
      threadStarts,
    }).pipe(Effect.provideService(Scope.Scope, rootScope));
    yield* Scope.close(rootScope, Exit.void);
    return result;
  });

it.effect("replays bounded lifecycle metadata after its local materialization commits", () =>
  withProtocol(
    ({
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
                text: "must never enter the deferred thread-start buffer",
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

it.effect("settles Nodex Agent calls directly from the protocol command lane", () =>
  withProtocol(({ inbox }) =>
    Effect.gen(function* () {
      const generationScope = yield* Scope.make();
      const generation = yield* inbox
        .openGeneration("local", 4)
        .pipe(Effect.provideService(Scope.Scope, generationScope));
      const settled = yield* generation.settlements.pipe(Stream.runHead, Effect.forkChild);
      yield* generation.admit({
        requestId: "nodex-call",
        protocol: "generated",
        method: "item/tool/call",
        params: {
          threadId: "thread-a",
          turnId: "turn-a",
          callId: "call-a",
          namespace: "nodex_app",
          tool: "get_context",
          arguments: {},
        },
      });

      const settlement = yield* Fiber.join(settled);
      assert.strictEqual(settlement._tag, "Some");
      if (settlement._tag === "Some") {
        assert.deepEqual(settlement.value.outcome, {
          kind: "result",
          value: {
            success: true,
            contentItems: [{ type: "inputText", text: "get_context" }],
          },
        });
      }
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
        params: directCodexAppParams("thread-b"),
      });

      const response = yield* Fiber.join(responseFiber);
      assert.strictEqual(response._tag, "Some");
      if (response._tag === "Some") {
        assert.deepEqual(response.value.outcome, {
          kind: "result",
          value: {
            success: true,
            contentItems: [{ type: "inputText", text: "setup_codex_step" }],
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

it.effect("keeps one-shot requests outside a blocked Thread command lane", () =>
  withProtocol(({ inbox, conversations }) =>
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
      yield* generation.admit({
        requestId: "time",
        protocol: "generated",
        method: "currentTime/read",
        params: { threadId: "thread-a" },
      });

      const settlement = yield* Fiber.join(settled);
      assert.strictEqual(settlement._tag, "Some");
      if (settlement._tag === "Some") {
        assert.strictEqual(settlement.value.outcome.kind, "result");
      }
      yield* Deferred.succeed(releaseLane, undefined);
      yield* Fiber.join(blocker);
      yield* Scope.close(generationScope, Exit.void);
    }),
  ),
);

it.effect("commits a request before the following resolution notification in the same Thread", () =>
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
        assert.strictEqual(settlement.value.outcome.kind, "result");
      }
      yield* Scope.close(generationScope, Exit.void);
    }),
  ),
);
