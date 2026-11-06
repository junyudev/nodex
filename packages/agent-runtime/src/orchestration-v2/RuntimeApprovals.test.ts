import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  RunId,
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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
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
