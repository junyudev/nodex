import type { TurnStartResponse, TurnSteerResponse } from "@nodex/codex-app-server-protocol/v2";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { CodexAutomationRunAcceptance } from "./CodexAutomationRunAcceptance";
import { CodexConversationMaterialization } from "./CodexConversationMaterialization";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexTurnAuthority } from "./CodexTurnAuthority";
import { make, type CodexTurnCommandsService } from "./CodexTurnCommands";
import {
  CodexTurnPreparation,
  type CodexTurnStartPlan,
  type CodexTurnSteerPlan,
} from "./CodexTurnPreparation";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";

const response = (): TurnStartResponse =>
  ({
    turn: {
      id: "turn-accepted",
      status: "inProgress",
      items: [{ id: "item-user", type: "userMessage", content: [] }],
    },
  }) as unknown as TurnStartResponse;

const missingThread = () =>
  codexRuntimeError({
    operation: "gateway.request",
    reason: "request",
    retryable: false,
    hostId: "local",
    method: "turn/start",
    cause: new CodexAppServerRequestError({
      code: -32600,
      errorMessage: "thread not found: thread-a",
    }),
  });

const plan = (attempt: number): CodexTurnStartPlan =>
  ({
    threadId: "thread-a",
    projectId: null,
    request: { threadId: "thread-a", input: [] },
    canonicalParams: { clientUserMessageId: `client-${attempt}` },
    currentCollaborationModel: "gpt-test",
    settings: {},
    permissionContext: {},
    clientUserMessageId: `client-${attempt}`,
    rendererOwnsState: false,
    verifiedBuiltinFullAccess: false,
    promptText: "ship",
    startedAtMs: attempt,
  }) as unknown as CodexTurnStartPlan;

const makeHarness = (input: {
  readonly request: (
    attempt: number,
  ) => Effect.Effect<TurnStartResponse, ReturnType<typeof missingThread>>;
  readonly failAcceptedProjection?: boolean;
  readonly steerPlan?: CodexTurnSteerPlan;
  readonly steerRequest?: (
    expectedTurnId: string,
  ) => Effect.Effect<TurnSteerResponse, ReturnType<typeof missingThread>>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const events: string[] = [];
    let requests = 0;
    let preparations = 0;
    const gateway = CodexGateway.of({
      localHostId: "local",
      requestRawOnHost: () => Effect.die("unused"),
      requestForThread: ((
        _threadId: string,
        method: string,
        params: { expectedTurnId?: string },
      ) => {
        if (method === "turn/steer" && input.steerRequest) {
          events.push(`steer:${params.expectedTurnId}`);
          return input.steerRequest(params.expectedTurnId!);
        }
        if (method !== "turn/start") return Effect.die(`unexpected method: ${method}`);
        requests += 1;
        events.push(`request:${requests}`);
        return input.request(requests);
      }) as CodexGateway["Service"]["requestForThread"],
    } as unknown as CodexGateway["Service"]);
    const materialization = CodexConversationMaterialization.of({
      ensure: () => Effect.sync(() => events.push("ensure")),
      reload: () => Effect.sync(() => events.push("reload")),
    });
    const preparation = CodexTurnPreparation.of({
      start: () =>
        Effect.sync(() => {
          preparations += 1;
          events.push(`prepare:${preparations}`);
          return plan(preparations);
        }),
      steer: () => (input.steerPlan ? Effect.succeed(input.steerPlan) : Effect.die("unused")),
    });
    const projection = CodexConversationProjection.of({
      admitSteer: ({ turnId }: { turnId: string }) =>
        Effect.sync(() => events.push(`admit-steer:${turnId}`)),
      retargetSteer: ({ fromTurnId, toTurnId }: { fromTurnId: string; toTurnId: string }) =>
        Effect.sync(() => events.push(`retarget-steer:${fromTurnId}:${toTurnId}`)),
      rejectSteer: ({ turnId }: { turnId: string }) =>
        Effect.sync(() => events.push(`reject-steer:${turnId}`)),
      configureTurn: () => Effect.sync(() => events.push("configure")),
      admitTurn: () => Effect.sync(() => events.push("admit")),
      markThreadActive: () => Effect.sync(() => events.push("active")),
      acceptTurn: () =>
        input.failAcceptedProjection
          ? Effect.fail({ _tag: "projection-failed" } as never)
          : Effect.sync(() => events.push("accept")),
      rejectTurn: () => Effect.sync(() => events.push("reject")),
      reconcileThreadStatus: () => Effect.sync(() => events.push("idle")),
    } as unknown as CodexConversationProjection["Service"]);
    const authority = CodexTurnAuthority.of({
      begin: () => Effect.sync(() => (events.push("authority:begin"), null)),
      bind: () => Effect.sync(() => events.push("authority:bind")),
      observeStarted: () => Effect.die("unused"),
      capture: () => Effect.die("unused"),
      inherit: () => Effect.die("unused"),
      abort: () => events.push("authority:abort"),
    });
    const automation = CodexAutomationRunAcceptance.of({
      accept: () => Effect.sync(() => (events.push("automation:accept"), true)),
    });
    const conversationsContext = yield* Layer.buildWithScope(conversationRuntimeMapLive, scope);
    const conversations = Context.get(conversationsContext, ConversationEntityMap);
    const aggregate = conversations.entity("thread-a");
    aggregate.installQueuedFollowUpProjection(
      {
        status: "ready",
        ledgerRevision: 1,
        projectionRevision: 1,
        entries: [
          {
            followUpId: "follow-up:paused",
            clientUserMessageId: "client-follow-up-paused",
            threadId: "thread-a",
            prompt: "later",
            promptInput: { text: "later" },
            createdAtMs: 1,
            collaborationMode: null,
            serviceTier: null,
            summary: null,
            pause: { kind: "failed", reason: "wait" },
            payloadRef: null,
          },
        ],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
      true,
    );
    const projectLifecycle = ProjectRuntimeLifecycleRuntime.of({
      runExclusive: (_projectId, operation) => operation,
    });
    const core = CoreModules.of({
      workspace: {
        read: () => Effect.die("unused"),
        apply: () => Effect.die("unused"),
      },
    } as unknown as CoreModuleClients);
    const commands: CodexTurnCommandsService = yield* make.pipe(
      Effect.provideService(CodexAutomationRunAcceptance, automation),
      Effect.provideService(CodexConversationMaterialization, materialization),
      Effect.provideService(CodexConversationProjection, projection),
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(CodexTurnAuthority, authority),
      Effect.provideService(CodexTurnPreparation, preparation),
      Effect.provideService(ConversationEntityMap, conversations),
      Effect.provideService(CoreModules, core),
      Effect.provideService(ProjectRuntimeLifecycleRuntime, projectLifecycle),
      Effect.provideService(Scope.Scope, scope),
    );
    return { aggregate, commands, events, requests: () => requests, scope };
  });

it.effect("rematerializes once after thread-not-found and retries a fresh transaction", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: (attempt) =>
        attempt === 1 ? Effect.fail(missingThread()) : Effect.succeed(response()),
    });

    const result = yield* harness.commands.start("thread-a", "ship");

    assert.strictEqual(result?.turnId, "turn-accepted");
    assert.strictEqual(harness.requests(), 2);
    assert.deepEqual(harness.events, [
      "ensure",
      "prepare:1",
      "configure",
      "authority:begin",
      "admit",
      "active",
      "request:1",
      "authority:abort",
      "reject",
      "idle",
      "reload",
      "prepare:2",
      "configure",
      "authority:begin",
      "admit",
      "active",
      "request:2",
      "authority:bind",
      "accept",
      "automation:accept",
      "active",
    ]);
    assert.deepEqual(harness.aggregate.readQueuedFollowUpProjection().entries[0]?.pause, {
      kind: "failed",
      reason: "wait",
    });
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("returns the accepted protocol outcome when a secondary projection fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: () => Effect.succeed(response()),
      failAcceptedProjection: true,
    });

    const result = yield* harness.commands.start("thread-a", "ship");

    assert.deepEqual(result, {
      threadId: "thread-a",
      turnId: "turn-accepted",
      status: "inProgress",
      itemIds: ["item-user"],
    });
    assert.isTrue(harness.events.includes("automation:accept"));
    assert.isFalse(harness.events.includes("reject"));
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("starts a system Automation turn without accepting its inbox run", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: () => Effect.succeed(response()),
    });

    const result = yield* harness.commands.startAutomation("thread-a", "ship");

    assert.strictEqual(result?.turnId, "turn-accepted");
    assert.isFalse(harness.events.includes("automation:accept"));
    assert.isTrue(harness.events.includes("accept"));
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

const questionSteerPlan = (): CodexTurnSteerPlan => ({
  threadId: "thread-a",
  expectedTurnId: "question-turn",
  steerId: "steer-question",
  request: { threadId: "thread-a", expectedTurnId: "question-turn", input: [] },
  item: {
    id: "steer-question",
    type: "steeringUserMessage",
    targetTurnId: "question-turn",
  } as CodexTurnSteerPlan["item"],
  fallbackStart: null,
});

for (const message of ["SteerTurnInactiveError: active turn not steerable"]) {
  it.effect(`does not redirect a question reply after ${message}`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed(response()),
        steerPlan: questionSteerPlan(),
        steerRequest: () =>
          Effect.fail(
            codexRuntimeError({
              operation: "gateway.request",
              reason: "request",
              retryable: false,
              hostId: "local",
              method: "turn/steer",
              cause: new CodexAppServerRequestError({ code: -32600, errorMessage: message }),
            }),
          ),
      });
      const result = yield* Effect.exit(
        harness.commands.steer({
          threadId: "thread-a",
          expectedTurnId: "question-turn",
          prompt: "answer",
        }),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(harness.requests(), 0);
      assert.deepEqual(harness.events, [
        "admit-steer:question-turn",
        "steer:question-turn",
        "reject-steer:question-turn",
      ]);
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
}

it.effect("accepts a question reply only in its originating Turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: () => Effect.succeed(response()),
      steerPlan: questionSteerPlan(),
      steerRequest: (turnId) => Effect.succeed({ turnId }),
    });
    assert.deepEqual(
      yield* harness.commands.steer({
        threadId: "thread-a",
        expectedTurnId: "question-turn",
        prompt: "answer",
      }),
      { turnId: "question-turn" },
    );
    assert.strictEqual(harness.requests(), 0);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

for (const mismatchMessage of [
  "expected active turn id 'question-turn' but found 'corrected-turn'",
  'ExpectedTurnMismatch { expected: "question-turn", actual: "corrected-turn" }',
])
  it.effect(`retries a question reply once after ${mismatchMessage}`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed(response()),
        steerPlan: questionSteerPlan(),
        steerRequest: (turnId) =>
          turnId === "corrected-turn"
            ? Effect.succeed({ turnId })
            : Effect.fail(
                codexRuntimeError({
                  operation: "gateway.request",
                  reason: "request",
                  retryable: false,
                  hostId: "local",
                  method: "turn/steer",
                  cause: new CodexAppServerRequestError({
                    code: -32600,
                    errorMessage: mismatchMessage,
                  }),
                }),
              ),
      });
      assert.deepEqual(
        yield* harness.commands.steer({
          threadId: "thread-a",
          expectedTurnId: "question-turn",
          prompt: "answer",
        }),
        { turnId: "corrected-turn" },
      );
      assert.strictEqual(harness.requests(), 0);
      assert.deepEqual(harness.events, [
        "admit-steer:question-turn",
        "steer:question-turn",
        "retarget-steer:question-turn:corrected-turn",
        "steer:corrected-turn",
      ]);
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );

it.effect("retains a dispatched question reply when its outcome is unknown", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: () => Effect.succeed(response()),
      steerPlan: questionSteerPlan(),
      steerRequest: () =>
        Effect.fail(
          codexRuntimeError({
            operation: "scheduler.execution",
            reason: "outcome-unknown",
            retryable: false,
            hostId: "local",
            method: "turn/steer",
          }),
        ),
    });
    assert.deepEqual(
      yield* harness.commands.steer({
        threadId: "thread-a",
        expectedTurnId: "question-turn",
        prompt: "answer",
      }),
      { turnId: "question-turn", outcome: "unknown" },
    );
    assert.deepEqual(harness.events, ["admit-steer:question-turn", "steer:question-turn"]);
    assert.strictEqual(harness.requests(), 0);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);
