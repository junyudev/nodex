import { latestNativeContextUsage } from "@t3tools/provider-core/contextUsage";
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
  TurnItemId,
  OrchestrationV2ThreadStreamItem,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";
import { projectTurnItemForDetail } from "./WireProjection.ts";
import { THREAD_HISTORY_PAGE_POLICY } from "./threadHistoryPaging.ts";

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
        kind: "user_input",
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
  "$storage: resolves the submitted message's Run rather than another foreground Run",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const events = fixtureEvents(now);
      yield* Effect.forEach(events, (event) => store.apply(event), { discard: true });
      const original = events.find((event) => event.type === "run.created")!;
      if (original.type !== "run.created") return;
      yield* store.apply({
        ...original,
        id: EventId.make("newer-run"),
        payload: {
          ...original.payload,
          id: RunId.make("run:newer"),
          ordinal: 2,
          userMessageId: MessageId.make("message:newer"),
        },
      });
      assert.deepEqual(yield* store.getRunOutcome({ threadId, messageId }), {
        runId,
        status: "running",
        completedAt: null,
        finalAssistantItemId: null,
      });
      assert.isNull(yield* store.getRunOutcome({ threadId: ThreadId.make("foreign"), messageId }));
      assert.isNull(yield* store.getRunOutcome({ threadId, messageId: MessageId.make("missing") }));
    }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "Run outcome reads only indexed metadata and locates the root assistant without decoding bodies",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      yield* Effect.forEach(fixtureEvents(now), (event) => store.apply(event), { discard: true });
      const giant = "x".repeat(2 * 1024 * 1024);
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text',${giant}) WHERE message_id=${messageId}`;
      yield* sql`INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,payload_json)
      VALUES('answer-node',${threadId},${runId},${nodeId},${nodeId},'assistant_message','completed','{}'),
        ('native-child',${threadId},${runId},'child-root','child-root','assistant_message','completed','{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json)
      VALUES('root-answer',${threadId},${runId},'answer-node',1,'assistant_message','completed',${DateTime.formatIso(now)},json_object('text',${giant})),
        ('native-child-answer',${threadId},${runId},'native-child',2,'assistant_message','completed',${DateTime.formatIso(now)},json_object('text',${giant}))`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed',completed_at=${DateTime.formatIso(now)} WHERE run_id=${runId}`;
      const expected = {
        runId,
        status: "completed",
        completedAt: DateTime.formatIso(now),
        finalAssistantItemId: TurnItemId.make("root-answer"),
      } satisfies ProjectionStore.ProjectionRunOutcome;
      assert.deepEqual(yield* store.getRunOutcome({ threadId, messageId }), expected);
      // Run lookup remains usable without a user-message body or provider session.
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json='invalid body' WHERE message_id=${messageId}`;
      yield* sql`DELETE FROM orchestration_v2_projection_provider_threads WHERE thread_id=${threadId}`;
      assert.deepEqual(yield* store.getRunOutcome({ threadId, runId }), expected);
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);

it.effect.each(storageCases)(
  "$storage: Run outcomes retain their own root reply and expose rollback settlement through either key",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const events = fixtureEvents(now);
      yield* Effect.forEach(events, (event) => store.apply(event), { discard: true });
      const runEvent = events.find((event) => event.type === "run.created")!;
      const newerRunId = RunId.make("run:newer");
      yield* store.apply({
        ...runEvent,
        id: EventId.make("newer-run"),
        payload: {
          ...runEvent.payload,
          id: newerRunId,
          ordinal: 2,
          userMessageId: MessageId.make("message:newer"),
        },
      });
      const replies = [
        { id: "first-root-reply", runId, rootNodeId: nodeId, ordinal: 1 },
        { id: "final-root-reply", runId, rootNodeId: nodeId, ordinal: 2 },
        { id: "child-reply", runId, rootNodeId: NodeId.make("child-root"), ordinal: 3 },
        { id: "next-run-reply", runId: newerRunId, rootNodeId: nodeId, ordinal: 4 },
        { id: "old-attempt-reply", runId, rootNodeId: NodeId.make("old-attempt"), ordinal: 5 },
      ];
      yield* Effect.forEach(
        replies,
        (reply) =>
          Effect.gen(function* () {
            const replyNodeId = NodeId.make(`node:${reply.id}`);
            // Providers project each assistant message as its own node under the attempt root.
            yield* store.apply({
              id: EventId.make(`node-event:${reply.id}`),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: replyNodeId,
                threadId,
                runId: reply.runId,
                parentNodeId: reply.rootNodeId,
                rootNodeId: reply.rootNodeId,
                kind: "assistant_message",
                status: "completed",
                countsForRun: false,
                providerThreadId,
                providerTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: now,
              },
            });
            yield* store.apply({
              id: EventId.make(`event:${reply.id}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                runId: reply.runId,
                ordinal: reply.ordinal,
                nodeId: replyNodeId,
                id: TurnItemId.make(reply.id),
                threadId,
                providerThreadId,
                providerTurnId,
                nativeItemRef: null,
                parentItemId: null,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "assistant_message",
                messageId: MessageId.make(`message:${reply.id}`),
                text: reply.id,
                streaming: false,
              },
            });
          }),
        { discard: true },
      );
      for (const status of [
        "completed",
        "failed",
        "interrupted",
        "cancelled",
        "rolled_back",
      ] as const) {
        yield* store.apply({
          ...runEvent,
          id: EventId.make(`settled:${status}`),
          type: "run.updated",
          payload: { ...runEvent.payload, status, activeAttemptId: null, completedAt: now },
        });
        const expected = {
          runId,
          status,
          completedAt: DateTime.formatIso(now),
          finalAssistantItemId: TurnItemId.make("final-root-reply"),
        };
        assert.deepEqual(yield* store.getRunOutcome({ threadId, runId }), expected);
        assert.deepEqual(yield* store.getRunOutcome({ threadId, messageId }), expected);
      }
      assert.isNull(yield* store.getRunOutcome({ threadId: ThreadId.make("foreign"), runId }));
      assert.isNull(yield* store.getRunOutcome({ threadId, runId: RunId.make("missing") }));
    }).pipe(Effect.provide(storeLayer)),
);

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
        yield* reply.respond({
          threadId,
          providerSessionId,
          requestId,
          answers: { scope: "Use the smaller fix." },
        });
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
              answers: { scope: "Use the smaller fix." },
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
  "Project activity checks descendant metadata and native background independently of a terminal foreground",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      yield* Effect.forEach(fixtureEvents(now), (event) => store.apply(event), { discard: true });
      const projectId = ProjectId.make("project:control-reads");
      const childId = ThreadId.make("thread:activity-child");
      yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,archived_at,deleted_at,payload_json)
      SELECT ${childId},project_id,'Child',default_provider,runtime_mode,interaction_mode,created_at,updated_at,
        updated_at,updated_at,'{"obsolete":"thread"}' FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      yield* sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id,thread_id,run_id,parent_node_id,provider,driver,provider_instance_id,provider_thread_id,child_thread_id,origin,status,started_at,completed_at,updated_at,payload_json)
      VALUES ('task:activity-child',${childId},NULL,'node:activity-child','codex','codex','codex',NULL,NULL,
        'provider_native','running',NULL,NULL,${DateTime.formatIso(now)},'{"obsolete":"task"}')`;
      yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'pending',payload_json = '{"obsolete":"request"}'
      WHERE runtime_request_id = ${requestId}`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{"obsolete":"run"}' WHERE run_id = ${runId}`;
      const initial = yield* store.getProjectExecutionActivity(projectId);
      assert.deepEqual(initial.run, { threadId, runId, status: "running" });
      assert.deepEqual(initial.runtimeRequest, { threadId, requestId });
      assert.deepEqual(initial.nativeBackground, {
        threadId: childId,
        taskId: "task:activity-child",
      });
      assert.isAtLeast(initial.snapshotSequence, 0);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = ${runId}`;
      yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved' WHERE runtime_request_id = ${requestId}`;
      const background = yield* store.getProjectExecutionActivity(projectId);
      assert.isNull(background.run);
      assert.isNull(background.runtimeRequest);
      assert.deepEqual(background.nativeBackground, initial.nativeBackground);
      yield* sql`UPDATE orchestration_v2_projection_subagents SET status = 'completed' WHERE subagent_id = 'task:activity-child'`;
      const idle = yield* store.getProjectExecutionActivity(projectId);
      assert.isNull(idle.nativeBackground);
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json,
      '$.pendingBackgroundTasks',json('[{"kind":"command","taskId":"shell:background"}]')) WHERE provider_thread_id = ${providerThreadId}`;
      const shell = yield* store.getProjectExecutionActivity(projectId);
      assert.deepEqual(shell.nativeBackground, { threadId, taskId: "shell:background" });
      const unrelated = yield* store.getProjectExecutionActivity(ProjectId.make("project:other"));
      assert.isNull(unrelated.run);
      assert.isNull(unrelated.runtimeRequest);
      assert.isNull(unrelated.nativeBackground);
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT request.thread_id,request.runtime_request_id FROM orchestration_v2_projection_threads AS thread
      CROSS JOIN orchestration_v2_projection_runtime_requests AS request ON request.thread_id = thread.thread_id
      WHERE thread.project_id = ${projectId} AND request.status IN ('pending','waiting') LIMIT 1`;
      assert.isTrue(plan.some((row) => row.detail.includes("threads_project_updated_idx")));
      assert.isTrue(plan.some((row) => row.detail.includes("runtime_requests_thread_status_idx")));
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);

it.effect.each(storageCases)(
  "$storage: Project activity reads live canonical metadata and becomes idle on settlement",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const events = fixtureEvents(now);
      yield* Effect.forEach(events, (event) => store.apply(event), { discard: true });
      const active = yield* store.getProjectExecutionActivity(
        ProjectId.make("project:control-reads"),
      );
      assert.deepEqual(active.run, { threadId, runId, status: "running" });
      const runEvent = events.find((event) => event.type === "run.created")!;
      yield* store.apply({
        ...runEvent,
        type: "run.updated",
        payload: { ...runEvent.payload, status: "completed", completedAt: now },
      });
      const idle = yield* store.getProjectExecutionActivity(
        ProjectId.make("project:control-reads"),
      );
      assert.isNull(idle.run);
      assert.isNull(idle.runtimeRequest);
      assert.isNull(idle.nativeBackground);
    }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "public snapshots retain a bounded visible/control closure from 10k same-Run tasks without task body decoding",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      yield* Effect.forEach(fixtureEvents(now), (event) => store.apply(event), { discard: true });
      const timestamp = DateTime.formatIso(now);
      yield* sql`WITH RECURSIVE task(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM task WHERE n < 10000)
      INSERT INTO orchestration_v2_projection_subagents
      (subagent_id,thread_id,run_id,parent_node_id,provider,driver,provider_instance_id,provider_thread_id,
       child_thread_id,origin,status,started_at,completed_at,updated_at,payload_json)
      SELECT printf('task:%05d',n),${threadId},${runId},${nodeId},'codex','codex','codex',NULL,NULL,
        'provider_native',CASE WHEN n % 2 = 0 THEN 'completed' ELSE 'running' END,${timestamp},NULL,${timestamp},
        json_object('id',printf('task:%05d',n),'threadId',${threadId},'runId',${runId},'parentNodeId',${nodeId},
          'origin','provider_native','createdBy','agent','driver','codex','providerInstanceId','codex',
          'providerThreadId',NULL,'childThreadId',NULL,'nativeTaskRef',NULL,'title','Inspect','model',NULL,
          'status',CASE WHEN n % 2 = 0 THEN 'completed' ELSE 'running' END,
          'startedAt',${timestamp},'completedAt',NULL,'updatedAt',${timestamp},
          'prompt',json_object('obsolete',1),'result',json_object('obsolete',1),'workflow',json_object('obsolete',1)) FROM task`;
      yield* sql`INSERT INTO orchestration_v2_projection_nodes
      (node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,
        runtime_request_id,checkpoint_scope_id,started_at,completed_at,payload_json)
      SELECT subagent_id,thread_id,run_id,${nodeId},${nodeId},'subagent',status,NULL,NULL,NULL,NULL,started_at,NULL,
        json_object('id',subagent_id,'threadId',thread_id,'runId',run_id,'parentNodeId',${nodeId},'rootNodeId',${nodeId},
          'kind','subagent','status',status,'countsForRun',json('true'),'providerThreadId',NULL,'providerTurnId',NULL,
          'nativeItemRef',NULL,'runtimeRequestId',NULL,'checkpointScopeId',NULL,'startedAt',started_at,'completedAt',NULL)
      FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id,thread_id,run_id,node_id,type,status,ordinal,updated_at,payload_json)
      SELECT 'item:' || subagent_id,thread_id,run_id,subagent_id,'subagent',status,CAST(substr(subagent_id,6) AS INTEGER),updated_at,
        json_object('id','item:' || subagent_id,'type','subagent','threadId',thread_id,'runId',run_id,'nodeId',subagent_id,
          'providerThreadId',NULL,'providerTurnId',NULL,'nativeItemRef',NULL,'parentItemId',NULL,
          'ordinal',CAST(substr(subagent_id,6) AS INTEGER),'status',status,'title','Inspect','startedAt',started_at,
          'completedAt',NULL,'updatedAt',updated_at,'subagentId',subagent_id,'origin','provider_native','driver','codex',
          'providerInstanceId','codex','childThreadId',NULL,'prompt',json_object('obsolete',1),'result',json_object('obsolete',1))
      FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}`;
      const giant = "x".repeat(20 * 1024 * 1024);
      yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json = json_set(payload_json,
      '$.prompt',${giant},'$.result',${giant}) WHERE subagent_id = 'task:10000'`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = json_set(payload_json,
      '$.prompt',${giant},'$.result',${giant}) WHERE turn_item_id = 'item:task:10000'`;
      // Full execution reads deliberately reject the obsolete bodies. The public SQL read never decodes them.
      assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
      const read = yield* store.getThreadSnapshotWindow(threadId, {
        rowLimit: 500,
        userTurnLimit: 5,
      });
      const control = yield* store.getThreadSnapshotWindow(threadId, {
        rowLimit: 0,
        controlOnly: true,
      });
      assert.lengthOf(control.projection.turnItems, 0);
      assert.lengthOf(control.projection.visibleTurnItems, 0);
      assert.lengthOf(control.projection.messages, 0);
      assert.isAtMost(control.projection.subagents.length, 4);
      assert.isAtMost(control.projection.nodes.length, 5);
      assert.isAtMost(read.projection.turnItems.length, 500);
      assert.isAtMost(read.projection.subagents.length, 504);
      assert.isAtMost(read.projection.nodes.length, 505);
      const snapshot = buildBoundedThreadStreamSnapshot({ ...read, compactTurnItems: true });
      const encoded = yield* Schema.encodeEffect(
        Schema.toCodecJson(OrchestrationV2ThreadStreamItem),
      )(snapshot);
      assert.isAtMost(
        Buffer.byteLength(JSON.stringify(encoded)),
        THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
      );
      assert.isAtMost(snapshot.projection.visibleTurnItems.length, 500);
      assert.isAtMost(
        snapshot.projection.subagents.length,
        snapshot.projection.visibleTurnItems.length + 4,
      );
      assert.isAtMost(
        snapshot.projection.nodes.length,
        snapshot.projection.visibleTurnItems.length + 5,
      );
      assert.isTrue(snapshot.hasMoreHistory);
      assert.isNotNull(snapshot.historyCursor);
      assert.isTrue(
        snapshot.projection.subagents.every(
          (task) => task.prompt === "" && task.result === null && task.workflow === undefined,
        ),
      );
      const older = yield* store.getThreadHistoryPage(threadId, snapshot.historyCursor!);
      assert.isAtMost(older.items.length, 500);
      assert.isTrue(
        older.items.every(
          (row) =>
            row.item.type === "subagent" && row.item.prompt === "" && row.item.result === null,
        ),
      );
      const detail = yield* store.getVisibleTurnItem({
        threadId,
        itemId: TurnItemId.make("item:task:10000"),
      });
      assert.equal(detail?.type, "subagent");
      assert.equal(detail?.type === "subagent" ? detail.prompt.length : 0, giant.length);
      assert.isAtMost(
        Buffer.byteLength(JSON.stringify(projectTurnItemForDetail(detail!))),
        THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
      );
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
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
      const addressed = yield* store.getThreadSubagentOverview({
        threadId,
        taskId: NodeId.make("task:00002"),
      });
      assert.equal(addressed.active.items.length, 0);
      assert.deepEqual([addressed.active.totalCount, addressed.terminal.totalCount], [0, 1]);
      assert.deepEqual(
        addressed.terminal.items.map((task) => task.id),
        ["task:00002"],
      );
      assert.isTrue(addressed.terminal.items[0]!.resultAvailable);
      assert.isBelow(JSON.stringify(addressed).length, 2048);
      const first = yield* store.getThreadSubagentOverview({ threadId });
      assert.equal(first.active.items.length, 4);
      assert.equal(first.terminal.items.length, 10);
      // Each section counts every task, not only the loaded page.
      assert.deepEqual([first.active.totalCount, first.terminal.totalCount], [5000, 5000]);
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

it.effect(
  "pages Project provider bindings by indexed metadata without decoding session or transcript bodies",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      yield* Effect.forEach(fixtureEvents(now), (event) => store.apply(event), { discard: true });
      const projectId = ProjectId.make("project:control-reads");
      yield* sql`UPDATE orchestration_v2_projection_provider_sessions SET payload_json = '{"obsolete":"body"}'`;
      yield* sql`WITH RECURSIVE indices(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM indices WHERE n<9999)
    INSERT INTO orchestration_v2_projection_provider_session_bindings(provider_session_id,thread_id)
    SELECT printf('session:pressure:%05d',n), ${threadId} FROM indices`;
      const collected: string[] = [];
      let cursor: string | undefined;
      do {
        const page = yield* store.getProjectProviderSessionBindings(projectId, cursor);
        assert.isAtMost(page.items.length, 64);
        assert.isAtMost(Buffer.byteLength(JSON.stringify(page), "utf8"), 16_384);
        assert.deepEqual(yield* store.getProjectProviderSessionBindings(projectId, cursor), page);
        collected.push(...page.items.map((row) => row.providerSessionId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      assert.equal(collected.length, 10_000);
      assert.equal(new Set(collected).size, collected.length);
      assert.deepEqual(
        (yield* store.getProjectProviderSessionBindings(ProjectId.make("foreign"))).items,
        [],
      );
      const first = yield* store.getProjectProviderSessionBindings(projectId);
      assert.equal(
        (yield* store
          .getProjectProviderSessionBindings(ProjectId.make("foreign"), first.nextCursor!)
          .pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);

it.effect.each(storageCases)(
  "$storage: context telemetry survives an empty transcript window and newer unmeasured Runs",
  ({ storeLayer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const events = fixtureEvents(now);
      const run = events.find((event) => event.type === "run.created")!;
      const attempt = events.find((event) => event.type === "run-attempt.created")!;
      const turn = events.find((event) => event.type === "provider-turn.updated")!;
      const provider = events.find((event) => event.type === "provider-thread.updated")!;
      yield* Effect.forEach(events, (event) => store.apply(event), { discard: true });
      yield* store.apply({
        ...attempt,
        id: EventId.make("measured-attempt"),
        type: "run-attempt.updated",
        payload: {
          ...attempt.payload,
          nativeThreadId: "native-control-thread",
          status: "completed",
          completedAt: now,
        },
      });
      yield* store.apply({
        ...turn,
        id: EventId.make("measured-turn"),
        payload: {
          ...turn.payload,
          status: "completed",
          completedAt: now,
          tokenUsage: {
            usedTokens: 50_000,
            maxTokens: 200_000,
            updatedAt: DateTime.formatIso(now),
          },
        },
      });
      yield* store.apply({
        ...run,
        id: EventId.make("completed-run"),
        type: "run.updated",
        payload: { ...run.payload, status: "completed", completedAt: now },
      });
      yield* store.apply({
        ...run,
        id: EventId.make("newer-unmeasured-run"),
        payload: {
          ...run.payload,
          id: RunId.make("newer-unmeasured-run"),
          ordinal: 2,
          status: "queued",
          rootNodeId: null,
          activeAttemptId: null,
          startedAt: null,
        },
      });
      const read = yield* store.getThreadSnapshotWindow(threadId, {
        rowLimit: 0,
        controlOnly: true,
      });
      const snapshot = buildBoundedThreadStreamSnapshot({ ...read, compactTurnItems: true });
      const restored = latestNativeContextUsage(
        snapshot.projection,
        snapshot.projection.providerThreads[0]!,
      );
      assert.deepEqual(restored?.usage, { usedTokens: 50_000, maxTokens: 200_000 });
      assert.equal(restored?.providerTurnId, providerTurnId);
      assert.lengthOf(snapshot.projection.visibleTurnItems, 0);
      assert.lengthOf(snapshot.projection.messages, 0);
      assert.lengthOf(snapshot.projection.providerTurns, 1);
      // Reusing a provider row after /clear or native replacement cannot revive the old report.
      yield* store.apply({
        ...provider,
        id: EventId.make("replaced-native"),
        payload: {
          ...provider.payload,
          nativeThreadRef: { driver, nativeId: "replacement", strength: "strong" },
        },
      });
      const replacement = yield* store.getThreadSnapshotWindow(threadId, {
        rowLimit: 0,
        controlOnly: true,
      });
      assert.isUndefined(
        latestNativeContextUsage(
          replacement.projection,
          replacement.projection.providerThreads[0]!,
        ),
      );
    }).pipe(Effect.provide(storeLayer)),
);
