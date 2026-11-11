import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  RunId,
  RunAttemptId,
  OrchestrationV2RuntimeRequestJson,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type ProviderApprovalOption,
  ProviderTurnId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type ProviderRequestKind,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@nodex/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import { RuntimeApprovals, type RuntimeApprovalRequest } from "./RuntimeApprovals.ts";
import * as RuntimeApprovalsLive from "./RuntimeApprovalsLive.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { readRootActivity } from "./ExecutionActivity.ts";
import { readSessionAttention } from "./SessionAttention.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.5" };

function layerTest(
  deliveries: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[],
  fails = false,
) {
  const adapter = ProviderAdapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            providerInstanceId: instanceId,
            driver,
            status: "ready",
            cwd: process.cwd(),
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          ensureThread: () => Effect.die("unused"),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: () => Effect.die("unused"),
          steerTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: (response) =>
            Effect.gen(function* () {
              deliveries.push(response);
              if (fails)
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver,
                  detail: "delivery unavailable",
                });
            }),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
  const database = Sqlite.layerMemory;
  return Layer.mergeAll(
    database,
    ProjectionStore.layer.pipe(Layer.provide(database)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "runtime-approvals" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  );
}

const seedApproval = (kind: ProviderRequestKind = "command") =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const threadId = ThreadId.make(`approval:${kind}`);
    const providerSessionId = ProviderSessionId.make(`session:${kind}`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${kind}`);
    const nodeId = NodeId.make(`node:${kind}`);
    const requestId = RuntimeRequestId.make(`request:${kind}`);
    const itemId = TurnItemId.make(`item:${kind}`);
    const now = yield* DateTime.now;
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${kind}`),
      threadId,
      projectId: ProjectId.make("project"),
      title: "Approvals",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* sessions.open({
      threadId,
      providerSessionId,
      modelSelection,
      runtimePolicy: {
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      },
    });
    const request: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind,
      status: "pending",
      responseCapability: { type: "live", providerSessionId, supportsFeedback: true },
      createdAt: now,
      resolvedAt: null,
    };
    yield* projections.apply({
      id: EventId.make(`request:${kind}`),
      threadId,
      occurredAt: now,
      type: "runtime-request.updated",
      payload: request,
    });
    yield* projections.apply({
      id: EventId.make(`node:${kind}`),
      threadId,
      occurredAt: now,
      type: "node.updated",
      payload: {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "approval_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`item:${kind}`),
      threadId,
      occurredAt: now,
      type: "turn-item.updated",
      payload: {
        id: itemId,
        threadId,
        runId: null,
        nodeId,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "approval_request",
        requestId,
        requestKind: kind,
        prompt: "git push origin main",
        options: [
          { decision: "accept", label: "Allow once" },
          { decision: "acceptForSession", label: "Allow for session" },
          { decision: "decline", label: "Decline" },
          { decision: "cancel", label: "Cancel" },
        ],
      },
    });
    return {
      engine,
      projections,
      sessions,
      threadId,
      providerSessionId,
      request,
      requestId,
      nodeId,
      now,
    };
  });

it.effect.each(["command", "file-read", "file-change", "permission", "mcp-elicitation"] as const)(
  "records and delivers one live %s approval, replaying only the accepted command",
  (kind) => {
    const deliveries: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
    return Effect.gen(function* () {
      const f = yield* seedApproval(kind);
      const command = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make(`answer:${kind}`),
        threadId: f.threadId,
        requestId: f.requestId,
        decision: "decline" as const,
        feedback: "Keep this local.",
      };
      const receipt = yield* f.engine.dispatch(command);
      assert.deepEqual(yield* f.engine.dispatch(command), receipt);
      const context = yield* f.projections.getRuntimeResponseContext(f.threadId, f.requestId);
      assert.equal(context.request?.status, "resolved");
      assert.equal(context.request?.decision, "decline");
      assert.equal(context.request?.feedback, "Keep this local.");
      assert.equal(context.node?.status, "cancelled");
      assert.equal(context.item?.status, "cancelled");
      assert.equal(context.item?.type === "approval_request" && context.item.decision, "decline");
      assert.equal(
        context.item?.type === "approval_request" && context.item.feedback,
        "Keep this local.",
      );
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      assert.equal((yield* outbox.listByCommandId(command.commandId)).length, 1);
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      assert.equal(yield* worker.drain(10), 1);
      assert.deepEqual(deliveries, [
        {
          modelPolicyOrigin: "person",
          requestId: f.requestId,
          decision: "decline",
          feedback: "Keep this local.",
        },
      ]);
      assert.deepEqual(yield* f.engine.dispatch(command), receipt);
      assert.equal(yield* worker.drain(10), 0);
      const second = yield* f.engine
        .dispatch({ ...command, commandId: CommandId.make(`second:${kind}`) })
        .pipe(Effect.result);
      assert.equal(second._tag, "Failure");
      assert.equal(deliveries.length, 1);
    }).pipe(Effect.provide(layerTest(deliveries)));
  },
);

it.effect("accepts session grants through the durable effect schema", () => {
  const deliveries: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
  return Effect.gen(function* () {
    const f = yield* seedApproval();
    yield* f.engine.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("accept-session"),
      threadId: f.threadId,
      requestId: f.requestId,
      decision: "acceptForSession",
    });
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(10);
    assert.deepEqual(deliveries, [
      { modelPolicyOrigin: "person", requestId: f.requestId, decision: "acceptForSession" },
    ]);
  }).pipe(Effect.provide(layerTest(deliveries)));
});

it.effect("requires live human decisions and validates decline feedback", () => {
  const deliveries: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
  return Effect.gen(function* () {
    const f = yield* seedApproval();
    const base = {
      type: "runtime-request.respond" as const,
      threadId: f.threadId,
      requestId: f.requestId,
    };
    const invalid = [
      {},
      { decision: "accept" as const, feedback: "No" },
      { decision: "decline" as const, feedback: "  " },
      { decision: "accept" as const, requirePending: true },
    ];
    for (const [i, response] of invalid.entries()) {
      const result = yield* f.engine
        .dispatch({ ...base, ...response, commandId: CommandId.make(`invalid:${i}`) })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }
    assert.equal(
      (yield* f.projections.getRuntimeRequest(f.threadId, f.requestId))?.status,
      "pending",
    );
    yield* f.projections.apply({
      id: EventId.make("no-feedback"),
      type: "runtime-request.updated",
      threadId: f.threadId,
      occurredAt: f.now,
      payload: {
        ...f.request,
        responseCapability: { type: "live", providerSessionId: f.providerSessionId },
      },
    });
    assert.equal(
      (yield* f.engine
        .dispatch({
          ...base,
          commandId: CommandId.make("invalid-feedback"),
          decision: "decline",
          feedback: "No",
        })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    for (const responseCapability of [
      { type: "message" as const },
      { type: "not_resumable" as const, reason: "Lost callback" },
    ]) {
      yield* f.projections.apply({
        id: EventId.make(`capability:${responseCapability.type}`),
        type: "runtime-request.updated",
        threadId: f.threadId,
        occurredAt: f.now,
        payload: { ...f.request, responseCapability },
      });
      assert.equal(
        (yield* f.engine
          .dispatch({
            ...base,
            commandId: CommandId.make(`invalid:${responseCapability.type}`),
            decision: "accept",
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
    }
    assert.isEmpty(deliveries);
  }).pipe(Effect.provide(layerTest(deliveries)));
});

it.effect("expires live approvals when their provider session is lost", () => {
  const deliveries: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
  return Effect.gen(function* () {
    const f = yield* seedApproval();
    yield* f.sessions.release({ providerSessionId: f.providerSessionId, reason: "runtime_error" });
    const request = yield* f.projections.getRuntimeRequest(f.threadId, f.requestId);
    assert.equal(request?.status, "expired");
    assert.equal(request?.responseCapability.type, "not_resumable");
    assert.equal(
      (yield* f.engine
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("stale-response"),
          threadId: f.threadId,
          requestId: f.requestId,
          decision: "accept",
        })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.isEmpty(deliveries);
  }).pipe(Effect.provide(layerTest(deliveries)));
});

it.effect("restart expires approvals and their waiting artifacts", () => {
  const deliveries: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
  return Effect.gen(function* () {
    const f = yield* seedApproval();
    const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService.pipe(
      Effect.provide(ProviderRuntimeRecoveryService.layer),
      Effect.provide(ServerSettings.layerTest()),
      Effect.provide(IdAllocator.layer),
    );
    yield* recovery.reconcile("startup");
    const context = yield* f.projections.getRuntimeResponseContext(f.threadId, f.requestId);
    assert.equal(context.request?.status, "expired");
    assert.equal(context.request?.responseCapability.type, "not_resumable");
    assert.equal(context.node?.status, "cancelled");
    assert.equal(context.item?.status, "cancelled");
  }).pipe(Effect.provide(layerTest(deliveries)));
});

it.effect("delivery failure never reopens an answered approval", () => {
  const deliveries: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
  return Effect.gen(function* () {
    const f = yield* seedApproval();
    const command = {
      type: "runtime-request.respond" as const,
      commandId: CommandId.make("failed-delivery"),
      threadId: f.threadId,
      requestId: f.requestId,
      decision: "accept" as const,
    };
    const receipt = yield* f.engine.dispatch(command);
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).runOnce;
    const request = yield* f.projections.getRuntimeRequest(f.threadId, f.requestId);
    assert.equal(request?.status, "resolved");
    assert.equal(request?.decision, "accept");
    assert.deepEqual(yield* f.engine.dispatch(command), receipt);
    assert.equal(deliveries.length, 1);
    const pending = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(command.commandId);
    assert.isNotNull(pending[0]?.lastError);
    assert.equal(pending[0]?.status, "failed");
    const history = yield* f.projections.getThreadProjection(f.threadId);
    assert.isTrue(
      history.turnItems.some(
        (item) =>
          item.type === "error" && item.failure.code === "approval_response_delivery_failed",
      ),
    );
  }).pipe(Effect.provide(layerTest(deliveries, true)));
});

it.effect("Stop cancels an approval even without a Run identity", () => {
  const deliveries: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
  return Effect.gen(function* () {
    const f = yield* seedApproval();
    yield* f.engine.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop:approval"),
      threadId: f.threadId,
    });
    const context = yield* f.projections.getRuntimeResponseContext(f.threadId, f.requestId);
    assert.equal(context.request?.status, "cancelled");
    assert.equal(context.request?.responseCapability.type, "not_resumable");
    assert.equal(context.node?.status, "cancelled");
    assert.equal(context.item?.status, "cancelled");
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(10);
    assert.isEmpty(deliveries);
  }).pipe(Effect.provide(layerTest(deliveries)));
});

it.effect.each(["running", "completed", "replaced"] as const)(
  "Decline and stop targets only its owning Run when it is %s",
  (state) => {
    const deliveries: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
    return Effect.gen(function* () {
      const f = yield* seedApproval("permission");
      const before = yield* f.projections.getRuntimeResponseContext(f.threadId, f.requestId);
      if (!before.node || !before.item) return yield* Effect.die("Missing approval artifacts");
      const runId = RunId.make("owning-run");
      const providerTurnId = ProviderTurnId.make("owning-turn");
      const providerThreadId = before.node.providerThreadId!;
      const rootId = NodeId.make("owning-root");
      const owningRun = {
        id: runId,
        threadId: f.threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("owning-message"),
        rootNodeId: rootId,
        activeAttemptId: null,
        status: state === "running" ? ("running" as const) : ("completed" as const),
        requestedAt: f.now,
        startedAt: f.now,
        completedAt: state === "running" ? null : f.now,
        checkpointId: null,
        contextHandoffId: null,
      };
      const root = {
        ...before.node,
        id: rootId,
        rootNodeId: rootId,
        runId,
        providerTurnId,
        kind: "root_turn" as const,
        status: "running" as const,
        countsForRun: true,
        runtimeRequestId: null,
      };
      const providerThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: f.providerSessionId,
        appThreadId: f.threadId,
        ownerNodeId: rootId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" as const },
        nativeConversationHeadRef: null,
        status: "active" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: f.now,
        updatedAt: f.now,
      };
      const providerTurn = {
        id: providerTurnId,
        providerThreadId,
        nodeId: rootId,
        runAttemptId: null,
        nativeTurnRef: { driver, nativeId: "native-turn", strength: "strong" as const },
        ordinal: 1,
        status: state === "running" ? ("running" as const) : ("completed" as const),
        startedAt: f.now,
        completedAt: state === "running" ? null : f.now,
      };
      const apply = (event: Parameters<typeof f.projections.apply>[0]) =>
        f.projections.apply(event);
      yield* apply({
        id: EventId.make("seed:run"),
        type: "run.updated",
        threadId: f.threadId,
        occurredAt: f.now,
        payload: owningRun,
      });
      yield* apply({
        id: EventId.make("seed:root"),
        type: "node.updated",
        threadId: f.threadId,
        occurredAt: f.now,
        payload: root,
      });
      yield* apply({
        id: EventId.make("seed:provider-thread"),
        type: "provider-thread.updated",
        threadId: f.threadId,
        occurredAt: f.now,
        payload: providerThread,
      });
      yield* apply({
        id: EventId.make("seed:provider-turn"),
        type: "provider-turn.updated",
        threadId: f.threadId,
        occurredAt: f.now,
        payload: providerTurn,
      });
      for (const suffix of ["", ":sibling"]) {
        const requestId = RuntimeRequestId.make(`${f.requestId}${suffix}`);
        const nodeId = NodeId.make(`${f.nodeId}${suffix}`);
        yield* apply({
          id: EventId.make(`seed:request${suffix}`),
          type: "runtime-request.updated",
          threadId: f.threadId,
          occurredAt: f.now,
          payload: { ...f.request, id: requestId, nodeId, providerTurnId },
        });
        yield* apply({
          id: EventId.make(`seed:node${suffix}`),
          type: "node.updated",
          threadId: f.threadId,
          occurredAt: f.now,
          payload: { ...before.node, id: nodeId, runId, rootNodeId: rootId, providerTurnId },
        });
        yield* apply({
          id: EventId.make(`seed:item${suffix}`),
          type: "turn-item.updated",
          threadId: f.threadId,
          occurredAt: f.now,
          payload: {
            ...before.item,
            id: TurnItemId.make(`item${suffix}`),
            nodeId,
            runId,
            providerTurnId,
            ...(before.item.type === "approval_request" ? { requestId } : {}),
          },
        });
      }
      if (state === "replaced")
        yield* apply({
          id: EventId.make("seed:replacement"),
          type: "run.updated",
          threadId: f.threadId,
          occurredAt: f.now,
          payload: {
            ...owningRun,
            id: RunId.make("replacement"),
            ordinal: 2,
            status: "running",
            completedAt: null,
          },
        });
      const command = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make(`cancel:${state}`),
        threadId: f.threadId,
        requestId: f.requestId,
        decision: "cancel" as const,
      };
      const receipt = yield* f.engine.dispatch(command);
      assert.deepEqual(yield* f.engine.dispatch(command), receipt);
      const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
        command.commandId,
      );
      const interrupts = effects.filter(
        (effect) => effect.request.type === "provider-turn.interrupt",
      );
      assert.equal(interrupts.length, state === "running" ? 1 : 0);
      if (interrupts[0]?.request.type === "provider-turn.interrupt")
        assert.equal(interrupts[0].request.providerTurnId, providerTurnId);
      if (state === "running") {
        const sibling = yield* f.projections.getRuntimeRequest(
          f.threadId,
          RuntimeRequestId.make(`${f.requestId}:sibling`),
        );
        assert.equal(sibling?.status, "cancelled");
        assert.equal(sibling?.responseCapability.type, "not_resumable");
      }
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(10);
      assert.deepEqual(deliveries, [
        { modelPolicyOrigin: "person", requestId: f.requestId, decision: "cancel" },
      ]);
      if (state === "replaced")
        assert.equal(
          (yield* f.engine.getThreadProjection(f.threadId)).runs.find(
            (run) => run.id === "replacement",
          )?.status,
          "running",
        );
    }).pipe(Effect.provide(layerTest(deliveries)));
  },
);

it.effect(
  "records and delivers the exact native approval scope without collapsing its decision",
  () => {
    const deliveries: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
    return Effect.gen(function* () {
      const f = yield* seedApproval("permission");
      const context = yield* f.projections.getRuntimeResponseContext(f.threadId, f.requestId);
      if (context.item?.type !== "approval_request")
        return yield* Effect.die("Missing approval item");
      yield* f.projections.apply({
        id: EventId.make("scope-options"),
        threadId: f.threadId,
        occurredAt: f.now,
        type: "turn-item.updated",
        payload: {
          ...context.item,
          options: [
            {
              optionId: "one-command",
              decision: "acceptForSession",
              label: "Allow this command for this chat",
            },
            {
              optionId: "directory",
              decision: "acceptForSession",
              label: "Allow commands in this directory for this chat",
            },
          ],
        },
      });
      const base = {
        type: "runtime-request.respond" as const,
        threadId: f.threadId,
        requestId: f.requestId,
        decision: "acceptForSession" as const,
      };
      for (const optionId of [undefined, "unknown"])
        assert.equal(
          (yield* f.engine
            .dispatch({
              ...base,
              commandId: CommandId.make(`invalid-scope:${optionId}`),
              ...(optionId === undefined ? {} : { optionId }),
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      const command = {
        ...base,
        commandId: CommandId.make("selected-scope"),
        optionId: "directory",
      };
      const receipt = yield* f.engine.dispatch(command);
      assert.deepEqual(yield* f.engine.dispatch(command), receipt);
      assert.equal(
        (yield* f.projections.getRuntimeRequest(f.threadId, f.requestId))?.optionId,
        "directory",
      );
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(10);
      assert.deepEqual(deliveries, [
        {
          modelPolicyOrigin: "person",
          requestId: f.requestId,
          decision: "acceptForSession",
          optionId: "directory",
        },
      ]);
    }).pipe(Effect.provide(layerTest(deliveries)));
  },
);

const runtimeGrant = "desktop-tools-javascript";
const sessionOptions: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Allow JavaScript for this chat" },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Decline and stop" },
];

const seedRuntimeAttempt = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSinkV2;
  const approvals = yield* RuntimeApprovals;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("runtime-approval-thread");
  const runId = RunId.make("runtime-approval-run");
  const attemptId = RunAttemptId.make("runtime-approval-attempt");
  const providerThreadId = ProviderThreadId.make("runtime-approval-provider-thread");
  const rootNodeId = NodeId.make("runtime-approval-root");
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:runtime-approval"),
    threadId,
    projectId: ProjectId.make("project"),
    title: "Runtime approvals",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });

  const base = { threadId, runId, occurredAt: now };
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make("runtime-approval-message"),
    rootNodeId,
    activeAttemptId: attemptId,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId,
    runId,
    attemptOrdinal: 1,
    rootNodeId,
    providerInstanceId: instanceId,
    providerThreadId,
    providerTurnId: null,
    reason: "initial",
    status: "running",
    startedAt: now,
    completedAt: null,
  };
  yield* events.write({
    events: [
      { ...base, id: EventId.make("runtime-test:run"), type: "run.updated", payload: run },
      {
        ...base,
        id: EventId.make("runtime-test:attempt"),
        type: "run-attempt.created",
        payload: attempt,
      },
      {
        ...base,
        id: EventId.make("runtime-test:root"),
        type: "node.updated",
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      },
      {
        ...base,
        id: EventId.make("runtime-test:provider-thread"),
        type: "provider-thread.updated",
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId: instanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: rootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
  });
  const start = (overrides: Partial<RuntimeApprovalRequest> = {}) =>
    Effect.gen(function* () {
      const afterSequence = yield* events.latestSequence({ threadId });
      const answer = yield* approvals
        .ask({
          threadId,
          runId,
          attemptId,
          kind: "command",
          prompt: "console.log('hello')",
          appName: "Browser",
          ...overrides,
        })
        .pipe(Effect.forkChild);
      const pendingCard = events.stream({ threadId, afterSequence }).pipe(
        Stream.filterMap(({ event }) =>
          event.type === "runtime-request.updated" &&
          event.payload.status === "pending" &&
          event.payload.responseCapability.type === "runtime"
            ? Result.succeed(event.payload)
            : Result.fail(undefined),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      const card = yield* Effect.raceFirst(
        pendingCard,
        Fiber.join(answer).pipe(
          Effect.andThen(Effect.die("Approval settled without opening a card")),
        ),
      );
      return { answer, card };
    });
  return {
    engine,
    projections,
    events,
    approvals,
    now,
    threadId,
    runId,
    attemptId,
    run,
    attempt,
    start,
  };
});

it.effect.each(["accept", "acceptForSession", "decline", "cancel"] as const)(
  "persists a Runtime approval and delivers %s from the outbox",
  (decision) => {
    const nativeDeliveries: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
    return Effect.gen(function* () {
      const f = yield* seedRuntimeAttempt;
      const withGrant = decision === "acceptForSession";
      const { answer, card } = yield* f.start(
        withGrant ? { options: sessionOptions, chatGrant: runtimeGrant } : {},
      );
      const context = yield* f.projections.getRuntimeResponseContext(f.threadId, card.id);
      assert.equal(context.node?.runId, f.runId);
      assert.equal(context.node?.parentNodeId, f.attempt.rootNodeId);
      assert.equal(card.providerTurnId, null);
      assert.equal(context.session, undefined);
      assert.equal(card.responseCapability.type, "runtime");
      assert.deepEqual(
        Schema.decodeUnknownSync(OrchestrationV2RuntimeRequestJson)(
          Schema.encodeSync(OrchestrationV2RuntimeRequestJson)(card),
        ),
        card,
      );
      if (context.item?.type !== "approval_request") return yield* Effect.die("Missing card");
      assert.equal(context.item.prompt, "console.log('hello')");
      assert.equal(context.item.appName, "Browser");
      assert.deepEqual(
        context.item.options?.map(({ decision }) => decision),
        withGrant
          ? ["accept", "acceptForSession", "decline", "cancel"]
          : ["accept", "decline", "cancel"],
      );
      assert.equal(
        (yield* f.projections.getThreadShell(f.threadId))?.pendingRuntimeRequest?.id,
        card.id,
      );
      const attention = yield* readSessionAttention([f.threadId], f.runId);
      assert.deepEqual(attention.get(f.threadId)?.activeFlags, ["waitingOnApproval"]);
      assert.deepEqual(attention.get(f.threadId)?.requests, [{ id: card.id, kind: "approval" }]);
      const activity = yield* readRootActivity({ rootThreadIds: [f.threadId] });
      assert.equal(activity.items[0]?.approvalPrompt, "console.log('hello')");
      if (!withGrant) {
        const result = yield* f.engine
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("unsupported-session-grant"),
            threadId: f.threadId,
            requestId: card.id,
            decision: "acceptForSession",
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }
      yield* f.engine.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("answer-runtime-approval"),
        threadId: f.threadId,
        requestId: card.id,
        decision,
      });
      const recorded = yield* f.projections.getRuntimeRequest(f.threadId, card.id);
      assert.equal(recorded?.status, "resolved");
      assert.equal(recorded?.decision, decision);
      if (decision !== "cancel") assert.isUndefined(answer.pollUnsafe());
      if (withGrant)
        assert.isTrue(
          yield* f.approvals.isAllowedForChat({
            threadId: f.threadId,
            grant: runtimeGrant,
          }),
        );
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(10);
      assert.equal(yield* Fiber.join(answer), decision);
      assert.isEmpty(nativeDeliveries);
      if (decision === "cancel")
        assert.equal(
          (yield* f.projections.getThreadProjection(f.threadId)).runs[0]?.status,
          "interrupted",
        );
    }).pipe(Effect.provide(layerTest(nativeDeliveries)));
  },
);

it.effect.each([
  "terminal attempt",
  "replacement attempt",
  "retirement",
  "interrupt",
  "stop",
  "archive",
  "delete",
  "abort",
  "restart",
] as const)("withdraws a Runtime approval on %s", (cause) =>
  Effect.gen(function* () {
    const f = yield* seedRuntimeAttempt;
    const abort = new AbortController();
    const { answer, card } = yield* f.start({ signal: abort.signal });
    const base = {
      id: EventId.make("runtime-test:end"),
      threadId: f.threadId,
      runId: f.runId,
      occurredAt: f.now,
    };
    switch (cause) {
      case "terminal attempt":
        yield* f.events.write({
          events: [
            {
              ...base,
              type: "run-attempt.updated",
              payload: { ...f.attempt, status: "completed", completedAt: f.now },
            },
          ],
        });
        break;
      case "replacement attempt":
        yield* f.events.write({
          events: [
            {
              ...base,
              type: "run.updated",
              payload: { ...f.run, activeAttemptId: RunAttemptId.make("replacement") },
            },
          ],
        });
        break;
      case "retirement": {
        const operationId = "runtime-test:retirement";
        const thread = yield* f.projections.getThread(f.threadId);
        yield* f.events.write({
          events: [
            {
              ...base,
              id: EventId.make("runtime-test:hold"),
              type: "thread.metadata-updated",
              payload: { ...thread, executionHandoff: { operationId, recoveryRequired: false } },
            },
          ],
        });
        yield* f.events.write({
          events: [
            {
              ...base,
              type: "run.execution-retired",
              payload: {
                runId: f.runId,
                attemptId: f.attemptId,
                rootNodeId: f.attempt.rootNodeId,
                providerThreadId: f.attempt.providerThreadId,
                cohortParentRunId: f.runId,
                deliveryRunId: null,
                operationId,
                retirementEffectId: null,
              },
            },
          ],
        });
        break;
      }
      case "interrupt":
        yield* f.engine.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("interrupt"),
          threadId: f.threadId,
          runId: f.runId,
        });
        break;
      case "stop":
      case "archive":
      case "delete":
        yield* f.engine.dispatch({
          type: `thread.${cause}`,
          commandId: CommandId.make(cause),
          threadId: f.threadId,
        });
        break;
      case "abort":
        abort.abort();
        break;
      case "restart": {
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService.pipe(
          Effect.provide(ProviderRuntimeRecoveryService.layer),
          Effect.provide(ServerSettings.layerTest()),
          Effect.provide(IdAllocator.layer),
        );
        yield* recovery.reconcile("startup");
        break;
      }
    }
    assert.equal(yield* Fiber.join(answer), "cancel");
    const context = yield* f.projections.getRuntimeResponseContext(f.threadId, card.id);
    assert.equal(context.request?.status, cause === "restart" ? "expired" : "cancelled");
    assert.equal(context.request?.responseCapability.type, "not_resumable");
    assert.equal(context.node?.status, "cancelled");
    assert.equal(context.item?.status, "cancelled");
  }).pipe(Effect.provide(layerTest([]))),
);

it.effect("refuses an old attempt and isolates simultaneous approvals on the current Run", () =>
  Effect.gen(function* () {
    const f = yield* seedRuntimeAttempt;
    yield* f.events.write({
      events: [
        {
          id: EventId.make("runtime-test:old-attempt"),
          threadId: f.threadId,
          runId: f.runId,
          occurredAt: f.now,
          type: "run-attempt.created",
          payload: { ...f.attempt, id: RunAttemptId.make("old-attempt"), attemptOrdinal: 2 },
        },
      ],
    });
    assert.equal(
      yield* f.approvals.ask({
        threadId: f.threadId,
        runId: f.runId,
        attemptId: RunAttemptId.make("old-attempt"),
        kind: "command",
        prompt: "old request",
      }),
      "cancel",
    );
    assert.isEmpty((yield* f.projections.getThreadProjection(f.threadId)).runtimeRequests);

    const first = yield* f.start();
    const second = yield* f.start({ prompt: "other request" });
    assert.notEqual(first.card.id, second.card.id);
    for (const [requestId, decision] of [
      [second.card.id, "decline"],
      [first.card.id, "accept"],
    ] as const) {
      yield* f.engine.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`answer:${decision}`),
        threadId: f.threadId,
        requestId,
        decision,
      });
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(10);
      if (decision === "decline") {
        assert.equal(yield* Fiber.join(second.answer), "decline");
        assert.isUndefined(first.answer.pollUnsafe());
      }
    }
    assert.equal(yield* Fiber.join(first.answer), "accept");
  }).pipe(Effect.provide(layerTest([]))),
);

it.effect("delivers an answer while the provider's effect lane is occupied", () =>
  Effect.gen(function* () {
    const f = yield* seedRuntimeAttempt;
    const { answer, card } = yield* f.start();
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const effectId = "provider-effect-in-flight";
    yield* outbox.enqueue([
      {
        id: effectId,
        commandId: CommandId.make(effectId),
        threadId: f.threadId,
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: ProviderSessionId.make("provider-effect-session"),
          providerThreadId: f.attempt.providerThreadId,
          providerTurnId: ProviderTurnId.make("provider-effect-turn"),
        },
      },
    ]);
    const claimed = yield* outbox.claimNext({
      workerId: "provider-worker",
      leaseDurationMs: 60_000,
    });
    assert.equal(Option.getOrThrow(claimed).id, effectId);

    yield* f.engine.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-during-provider-effect"),
      threadId: f.threadId,
      requestId: card.id,
      decision: "accept",
    });
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).runOnce;
    assert.equal(yield* Fiber.join(answer), "accept");
    assert.equal(Option.getOrThrow(yield* outbox.get(effectId)).status, "running");
  }).pipe(Effect.provide(layerTest([]))),
);

it.effect(
  "persists chat allowances across service replacement, ends them on a mode change, and excludes forks",
  () =>
    Effect.gen(function* () {
      const f = yield* seedRuntimeAttempt;
      const grant = { threadId: f.threadId, grant: runtimeGrant } as const;
      const beforeGrant = yield* f.projections.getThread(f.threadId);
      yield* f.approvals.allowForChat(grant);
      const withGrant = yield* f.projections.getThread(f.threadId);
      const updateTitle = (thread: typeof beforeGrant, title: string) =>
        f.events.write({
          events: [
            {
              id: EventId.make(`runtime-test:title:${title}`),
              type: "thread.metadata-updated",
              threadId: f.threadId,
              occurredAt: f.now,
              payload: { ...thread, title },
            },
          ],
        });
      yield* updateTitle(beforeGrant, "Approval title");
      const restarted = yield* RuntimeApprovals.pipe(
        Effect.provide(
          RuntimeApprovalsLive.layer.pipe(Layer.fresh, Layer.provide(ThreadCommandExecutor.layer)),
        ),
      );
      assert.isTrue(yield* restarted.isAllowedForChat(grant));

      const forkId = ThreadId.make("runtime-approval-fork");
      yield* f.engine.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-runtime-approval-thread"),
        sourceThreadId: f.threadId,
        targetThreadId: forkId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "web",
      });
      assert.isFalse(yield* restarted.isAllowedForChat({ ...grant, threadId: forkId }));
      assert.isTrue(yield* restarted.isAllowedForChat(grant));
      for (const [index, mode] of (
        ["approval-required", "auto", "approval-required"] as const
      ).entries()) {
        yield* f.engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`permission-mode:${index}`),
          threadId: f.threadId,
          runtimeMode: mode,
        });
        assert.equal((yield* f.projections.getThread(f.threadId)).runtimeMode, mode);
        assert.equal(yield* restarted.isAllowedForChat(grant), index === 0);
        if (mode === "auto") {
          yield* updateTitle(withGrant, "Title from before the mode change");
          assert.equal((yield* f.projections.getThread(f.threadId)).runtimeMode, "auto");
          assert.isFalse(yield* restarted.isAllowedForChat(grant));
        }
      }
      yield* updateTitle(withGrant, "Updated approval title");
      assert.isFalse(yield* restarted.isAllowedForChat(grant));
    }).pipe(Effect.provide(layerTest([]))),
);

it.effect("clears chat grants on a metadata mode change and fences stale writes in the batch", () =>
  Effect.gen(function* () {
    const f = yield* seedRuntimeAttempt;
    const grant = { threadId: f.threadId, grant: runtimeGrant } as const;
    yield* f.approvals.allowForChat(grant);
    const withGrant = yield* f.projections.getThread(f.threadId);
    const { answer } = yield* f.start({ options: sessionOptions, chatGrant: runtimeGrant });
    const metadata = {
      type: "thread.metadata-updated",
      threadId: f.threadId,
      occurredAt: f.now,
    } as const;
    yield* f.events.write({
      events: [
        {
          ...metadata,
          id: EventId.make("runtime-test:metadata-mode-change"),
          payload: { ...withGrant, runtimeMode: "full-access" },
        },
        {
          ...metadata,
          id: EventId.make("runtime-test:stale-metadata"),
          payload: { ...withGrant, title: "Renamed chat" },
        },
      ],
    });
    const updated = yield* f.projections.getThread(f.threadId);
    assert.equal(updated.runtimeMode, "full-access");
    assert.equal(updated.title, "Renamed chat");
    assert.isFalse(yield* f.approvals.isAllowedForChat(grant));
    assert.equal(yield* Fiber.join(answer), "cancel");
  }).pipe(Effect.provide(layerTest([]))),
);

it.effect("withdraws a chat-grant offer when its permission mode changes", () =>
  Effect.gen(function* () {
    const f = yield* seedRuntimeAttempt;
    const { answer, card } = yield* f.start({ options: sessionOptions, chatGrant: runtimeGrant });
    for (const runtimeMode of ["auto", "approval-required"] as const)
      yield* f.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make(`mode:${runtimeMode}`),
        threadId: f.threadId,
        runtimeMode,
      });
    assert.equal(yield* Fiber.join(answer), "cancel");
    assert.equal(
      (yield* f.projections.getRuntimeRequest(f.threadId, card.id))?.status,
      "cancelled",
    );
    assert.isFalse(
      yield* f.approvals.isAllowedForChat({ threadId: f.threadId, grant: runtimeGrant }),
    );
  }).pipe(Effect.provide(layerTest([]))),
);
