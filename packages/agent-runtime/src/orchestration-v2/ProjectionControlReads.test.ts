import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";

const threadId = ThreadId.make("thread:control-reads");
const providerThreadId = ProviderThreadId.make("provider-thread:control-reads");
const providerTurnId = ProviderTurnId.make("provider-turn:control-reads");
const providerSessionId = ProviderSessionId.make("session:control-reads");
const attemptId = RunAttemptId.make("attempt:control-reads");
const runId = RunId.make("run:control-reads");
const messageId = MessageId.make("message:control-reads");
const requestId = RuntimeRequestId.make("request:control-reads");
const nodeId = NodeId.make("node:control-reads");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-6" };

function fixtureEvents(now: DateTime.Utc): ReadonlyArray<OrchestrationV2DomainEvent> {
  const common = { threadId, occurredAt: now };
  return [
    {
      ...common,
      id: EventId.make("control:thread"),
      type: "thread.created",
      payload: {
        id: threadId,
        projectId: ProjectId.make("project:control-reads"),
        title: "Control reads",
        providerInstanceId,
        modelSelection,
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace",
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:provider-thread"),
      type: "provider-thread.updated",
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-control-thread", strength: "strong" },
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
    {
      ...common,
      id: EventId.make("control:run"),
      type: "run.created",
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:attempt"),
      type: "run-attempt.created",
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId,
        reason: "initial",
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:turn"),
      type: "provider-turn.updated",
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: "native-control-turn", strength: "strong" },
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:message"),
      type: "message.updated",
      payload: {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Use the smaller fix.",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      ...common,
      id: EventId.make("control:request"),
      type: "runtime-request.updated",
      payload: {
        id: requestId,
        nodeId,
        providerTurnId,
        nativeRequestRef: null,
        kind: "command",
        status: "resolved",
        responseCapability: { type: "live", providerSessionId },
        createdAt: now,
        resolvedAt: now,
      },
    },
  ];
}

const storageCases = (["sqlite", "memory"] as const).map((storage) => ({
  storage,
  storeLayer:
    storage === "sqlite"
      ? ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))
      : ProjectionStore.layerMemory,
}));

it.effect.each(storageCases)(
  "$storage: finds the active root turn without an attempt reverse link",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const events = fixtureEvents(now).map((event) =>
        event.type === "run-attempt.created"
          ? { ...event, payload: { ...event.payload, providerTurnId: null } }
          : event,
      );
      yield* Effect.forEach(events, (event) => store.apply(event), { discard: true });
      const running = yield* store.getRunningTurnContext(threadId);
      assert.equal(running.providerTurn?.id, providerTurnId);
      const turnEvent = events.find((event) => event.type === "provider-turn.updated")!;
      yield* store.apply({
        ...turnEvent,
        payload: { ...turnEvent.payload, status: "completed", completedAt: now },
      });
      assert.isUndefined((yield* store.getRunningTurnContext(threadId)).providerTurn);
    }).pipe(Effect.provide(storeLayer)),
);
it.effect.each(storageCases)(
  "$storage: controls and replies read only their exact durable targets",
  ({ storage, storeLayer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const events = fixtureEvents(now);
      yield* Effect.forEach(events, (event) => store.apply(event), { discard: true });
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('message:unrelated-obsolete', ${threadId}, ${runId}, ${nodeId}, 'assistant', 0,
          ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":"transcript"}')`;
        assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
        const queryPlan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
          SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND node_id = ${nodeId}
            AND type IN ('approval_request', 'user_input_request')
            AND json_extract(payload_json, '$.requestId') = ${requestId}
          ORDER BY ordinal ASC LIMIT 1`;
        assert.isTrue(queryPlan.some((row) => row.detail.includes("turn_items_node_ordinal_idx")));
      }
      const running = yield* store.getRunningTurnContext(threadId);
      assert.equal(running.run?.id, runId);
      assert.equal(running.providerThread?.id, providerThreadId);
      assert.equal(running.providerTurn?.id, providerTurnId);
      const providerContext = yield* store.getThreadProviderContext(threadId, providerInstanceId);
      assert.equal(providerContext.thread.id, threadId);
      assert.deepEqual(
        providerContext.providerThreads.map((thread) => thread.id),
        [providerThreadId],
      );
      const responseContext = yield* store.getRuntimeResponseContext(threadId, requestId);
      assert.equal(responseContext.request?.id, requestId);
      const target = { providerThreadId, providerTurnId, attemptId, messageId };
      const context = yield* store.getProviderControlContext(threadId, target);
      assert.equal(context.providerThread?.id, providerThreadId);
      assert.equal(context.providerTurn?.id, providerTurnId);
      assert.equal(context.attempt?.id, attemptId);
      assert.equal(context.message?.text, "Use the smaller fix.");
      assert.equal(context.run?.id, runId);
      assert.equal((yield* store.getRuntimeRequest(threadId, requestId))?.status, "resolved");
      assert.isUndefined(
        yield* store.getRuntimeRequest(threadId, RuntimeRequestId.make("request:missing")),
      );
      const absent = yield* store.getProviderControlContext(threadId, {
        providerThreadId: ProviderThreadId.make("provider-thread:missing"),
        providerTurnId: ProviderTurnId.make("provider-turn:missing"),
      });
      assert.isUndefined(absent.providerThread);
      assert.isUndefined(absent.providerTurn);
      const missingThread = yield* store
        .getRuntimeRequest(ThreadId.make("thread:missing"), requestId)
        .pipe(Effect.flip);
      assert.instanceOf(missingThread, ProjectionStore.ProjectionStoreThreadNotFoundError);

      const calls: string[] = [];
      const layerSessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        get: () =>
          Effect.succeed(
            Option.some({
              interruptTurn: () =>
                Effect.sync(() => {
                  calls.push("interrupt");
                }),
              steerTurn: (input: { message: { text: string }; runId: RunId }) =>
                Effect.sync(() => {
                  assert.equal(input.runId, runId);
                  calls.push(input.message.text);
                }),
              respondToRuntimeRequest: () =>
                Effect.sync(() => {
                  calls.push("reply");
                }),
            } as never),
          ),
      });
      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const reply = yield* RuntimeRequestService.RuntimeRequestServiceV2;
        yield* control.interrupt({ threadId, providerThreadId, providerTurnId, providerSessionId });
        yield* control.steer({
          threadId,
          providerThreadId,
          providerTurnId,
          providerSessionId,
          messageId,
        });
        yield* reply.respond({ threadId, providerSessionId, requestId, decision: "accept" });
        assert.deepEqual(calls, ["interrupt", "Use the smaller fix.", "reply"]);
        const wrongSession = ProviderSessionId.make("session:wrong");
        assert.equal(
          (yield* Effect.exit(
            control.interrupt({
              threadId,
              providerThreadId,
              providerTurnId,
              providerSessionId: wrongSession,
            }),
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(
            reply.respond({
              threadId,
              providerSessionId: wrongSession,
              requestId,
              decision: "accept",
            }),
          ))._tag,
          "Failure",
        );
        assert.lengthOf(calls, 3);
        const turn = context.providerTurn!;
        yield* store.apply({
          id: EventId.make("control:turn-completed"),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload: { ...turn, status: "completed", completedAt: now },
        });
        // A settled turn's Stop still reaches the adapter, which alone knows
        // whether it runs background work for the thread.
        yield* control.interrupt({ threadId, providerThreadId, providerTurnId, providerSessionId });
        assert.deepEqual(calls, ["interrupt", "Use the smaller fix.", "reply", "interrupt"]);
      }).pipe(
        Effect.provide(
          Layer.merge(ProviderTurnControlService.layer, RuntimeRequestService.layer).pipe(
            Layer.provide(layerSessions),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.merge(storeLayer, SqlitePersistence.layerMemory))),
);

it.effect(
  "task overview admits indexed metadata pages from 10k tasks without decoding task bodies",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      yield* store.apply(fixtureEvents(now)[0]!);
      const timestamp = DateTime.formatIso(now);
      // Scale is the explicit storage boundary here. Body fields are deliberately invalid for the full task decoder.
      yield* sql`WITH RECURSIVE task(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM task WHERE n < 10000)
      INSERT INTO orchestration_v2_projection_subagents
      (subagent_id,thread_id,run_id,parent_node_id,provider,driver,provider_instance_id,provider_thread_id,
       child_thread_id,origin,status,started_at,completed_at,updated_at,payload_json)
      SELECT printf('task:%05d',n), ${threadId}, NULL, ${nodeId}, 'codex', 'codex', 'codex', NULL, NULL,
        'provider_native', CASE WHEN n % 2 = 0 THEN 'completed' ELSE 'running' END,
        ${timestamp},NULL,${timestamp},json_object('title','Bounded task','model',NULL,'prompt',json_object('obsolete',1),'result',json_object('obsolete',1))
      FROM task`;
      const giant = "x".repeat(2 * 1024 * 1024);
      yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json = json_set(payload_json,
      '$.prompt',${giant},'$.result',${giant}) WHERE subagent_id = 'task:10000'`;
      assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
      const first = yield* store.getThreadSubagentOverview({ threadId });
      assert.equal(first.active.items.length, 4);
      assert.equal(first.terminal.items.length, 10);
      assert.equal(first.terminal.items[0]?.id, "task:10000");
      assert.isTrue(first.terminal.items[0]!.resultAvailable);
      assert.isBelow(JSON.stringify(first).length, 16 * 1024);
      const second = yield* store.getThreadSubagentOverview({
        threadId,
        activeCursor: first.active.nextCursor!,
        terminalCursor: first.terminal.nextCursor!,
      });
      assert.equal(
        new Set([...first.active.items, ...second.active.items].map((task) => task.id)).size,
        8,
      );
      assert.equal(
        new Set([...first.terminal.items, ...second.terminal.items].map((task) => task.id)).size,
        20,
      );
      assert.equal(
        (yield* Effect.exit(
          store.getThreadSubagentOverview({ threadId, activeCursor: first.terminal.nextCursor! }),
        ))._tag,
        "Failure",
      );
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT subagent_id,updated_at
      FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}
      AND CASE WHEN status IN ('completed','failed','cancelled','interrupted') THEN 'terminal' ELSE 'active' END = 'active'
      ORDER BY updated_at DESC,subagent_id DESC LIMIT 5`;
      assert.isTrue(plan.some((row) => row.detail.includes("subagent_overview_idx")));
      assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);
