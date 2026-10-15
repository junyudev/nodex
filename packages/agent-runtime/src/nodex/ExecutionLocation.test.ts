import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2, layer as storeLayer } from "../orchestration-v2/ProjectionStore.ts";
import { EffectOutboxV2, layer as outboxLayer } from "../orchestration-v2/EffectOutbox.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { make } from "./ExecutionLocation.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("This boundary proves durable admission without native startup"),
};
const database = SqlitePersistence.layerMemory;
const runtimeLayer = Harness.layerWithRegistry(
  { name: "execution-location" },
  Registry.layerSingle(adapter),
  { runEffectWorker: false, databaseLayer: database },
).pipe(Layer.provideMerge(Layer.merge(storeLayer, outboxLayer).pipe(Layer.provideMerge(database))));
const layer = EventSink.layer.pipe(
  Layer.provideMerge(EventStore.layer.pipe(Layer.provideMerge(runtimeLayer))),
);
const source = {
  hostId: "local",
  cwd: process.cwd(),
  workspaceRoots: [process.cwd()],
  managedWorktreePath: null,
  projectId: "project:move",
  projectlessOutputDirectory: null,
  projectlessWorkspaceBrowserRoot: null,
};
const create = Effect.fnUntraced(function* (id: string) {
  const writer = yield* OrchestratorV2;
  const threadId = ThreadId.make(id);
  yield* writer.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId,
    projectId: ProjectId.make("project:move"),
    title: "Move",
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: source.cwd,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});
const send = (threadId: ThreadId, id: string, queue = false) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(id),
  threadId,
  messageId: MessageId.make(id),
  text: id,
  attachments: [],
  createdBy: "user" as const,
  creationSource: "web" as const,
  dispatchMode: { type: queue ? ("queue_after_active" as const) : ("start_immediately" as const) },
});

it.effect(
  "persists the execution seal, replays accepted input and resumes only an unheld queue",
  () =>
    Effect.gen(function* () {
      const writer = yield* OrchestratorV2,
        store = yield* ProjectionStoreV2;
      const threadId = yield* create("thread:move");
      const execution = yield* make;
      const first = send(threadId, "first");
      const accepted = yield* writer.dispatch(first);
      yield* writer.dispatch(send(threadId, "queued", true));
      yield* execution.hold({
        threadId,
        operationId: "move:1",
        action: "acquire",
        sourceLocation: source,
      });
      const sink = yield* EventSink.EventSinkV2;
      const plannedRun = (yield* store.getThreadRecords(threadId, ["runs"])).runs[0]!;
      const latePlan = yield* sink
        .write({
          events: [
            {
              type: "run.created",
              id: EventId.make("late:plan"),
              threadId,
              occurredAt: yield* DateTime.now,
              payload: { ...plannedRun, id: plannedRun.id, ordinal: 99 },
            },
          ],
        })
        .pipe(Effect.result);
      assert.equal(
        latePlan._tag,
        "Failure",
        "The SQL commit must recheck a plan made before the root seal",
      );
      assert.equal((yield* writer.dispatch(first)).sequence, accepted.sequence);
      const after = send(threadId, "after");
      assert.equal((yield* writer.dispatch(after).pipe(Effect.result))._tag, "Failure");
      // A reconstructed owner reads the same persisted transaction; it cannot admit a new move.
      const restarted = yield* make;
      assert.equal(
        (yield* restarted
          .hold({ threadId, operationId: "move:other", action: "acquire", sourceLocation: source })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      // The public active-Run quiesce must not hydrate the historical prompts or Run bodies.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_runs SET ordinal = ordinal + 1000,
        payload_json = json_set(payload_json,'$.ordinal',ordinal + 1000) WHERE thread_id = ${threadId}`;
      const cold = `COLD_EXECUTION_RETIREMENT:${"x".repeat(64 * 1024)}`;
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1000)
        INSERT INTO orchestration_v2_projection_runs
          (run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,completed_at,payload_json)
        SELECT 'cold-retirement-run:' || n.i, r.thread_id, n.i, r.provider, r.provider_thread_id, 'completed', r.requested_at, r.requested_at,
          json_set(r.payload_json,'$.id','cold-retirement-run:' || n.i,'$.ordinal',n.i,'$.status','completed','$.coldBody',${cold})
        FROM n CROSS JOIN orchestration_v2_projection_runs r WHERE r.run_id = ${plannedRun.id}`;
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1000)
        INSERT INTO orchestration_v2_projection_messages
          (message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json)
        SELECT 'cold-retirement-message:' || n.i, m.thread_id, 'cold-retirement-run:' || n.i, m.node_id, m.role, 0, m.created_at,m.updated_at,
          json_set(m.payload_json,'$.id','cold-retirement-message:' || n.i,'$.runId','cold-retirement-run:' || n.i,'$.text',${cold})
        FROM n CROSS JOIN orchestration_v2_projection_messages m WHERE m.message_id = ${plannedRun.userMessageId}`;
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1000)
        INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json)
        SELECT 'cold-retirement-item:' || n.i, item.thread_id, ${plannedRun.id}, item.node_id,item.provider_thread_id,NULL,n.i+100,'assistant_message','completed',item.updated_at,
          json_set(item.payload_json,'$.id','cold-retirement-item:' || n.i,'$.type','assistant_message','$.status','completed',
            '$.ordinal',n.i+100,'$.text',${cold},'$.streaming',json('false'))
        FROM n CROSS JOIN orchestration_v2_projection_turn_items item WHERE item.thread_id = ${threadId}
          AND item.run_id = ${plannedRun.id} AND item.type = 'user_message'`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = '{broken'
        WHERE turn_item_id = 'cold-retirement-item:1'`;
      yield* sql`INSERT INTO orchestration_v2_projection_subagents
        (subagent_id,thread_id,run_id,parent_node_id,provider,provider_thread_id,child_thread_id,origin,status,started_at,completed_at,updated_at,payload_json)
        VALUES ('cold-retirement-task',${threadId},${plannedRun.id},${plannedRun.rootNodeId},'codex',NULL,NULL,'app_owned','completed',NULL,NULL,'2026-10-15T00:00:00.000Z','{broken')`;
      const streamingPlan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN UPDATE orchestration_v2_projection_turn_items
        SET updated_at = updated_at WHERE thread_id = ${threadId} AND run_id = ${plannedRun.id}
          AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.streaming') END = 1`;
      assert.isTrue(
        streamingPlan.some((row) =>
          row.detail.includes("orchestration_v2_execution_streaming_items_idx"),
        ),
      );
      const hydrated: string[] = [];
      const parse = JSON.parse;
      const trace = vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
        if (typeof value === "string" && value.includes("COLD_EXECUTION_RETIREMENT"))
          hydrated.push(value);
        return parse(value, reviver);
      });
      try {
        yield* restarted.quiesce({ threadId, operationId: "move:1" });
        assert.deepEqual(hydrated, []);
      } finally {
        trace.mockRestore();
      }
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId} AND turn_item_id LIKE 'cold-retirement-item:%'`;
      yield* sql`DELETE FROM orchestration_v2_projection_subagents WHERE subagent_id = 'cold-retirement-task'`;
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId} AND message_id LIKE 'cold-retirement-message:%'`;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} AND run_id LIKE 'cold-retirement-run:%'`;
      let records = yield* store.getThreadRecords(threadId, ["runs"]);
      const queued = records.runs.find((r) => r.userMessageId === "queued")!;
      assert.equal(queued.status, "queued");
      assert.isFalse(queued.queueHeld ?? false);
      assert.isNull((yield* writer.getThreadShell(threadId))?.activeRunId);
      const destination = {
        ...source,
        cwd: `${source.cwd}/packages`,
        workspaceRoots: [`${source.cwd}/packages`],
        managedWorktreePath: `${source.cwd}/packages`,
      };
      yield* restarted.commit({ threadId, operationId: "move:1", location: destination });
      yield* restarted.commit({ threadId, operationId: "move:1", location: destination });
      yield* restarted.hold({ threadId, operationId: "move:1", action: "release" });
      records = yield* store.getThreadRecords(threadId, ["runs"]);
      assert.equal(records.runs.find((r) => r.id === queued.id)?.status, "starting");
      assert.equal((yield* store.getThread(threadId)).worktreePath, destination.cwd);
      assert.equal(
        (yield* writer.dispatch(after)).storedEvents.some((e) => e.event.type === "run.created"),
        true,
      );
      const heldThreadId = yield* create("thread:already-held");
      yield* writer.dispatch(send(heldThreadId, "held-first"));
      yield* writer.dispatch(send(heldThreadId, "held-queued", true));
      const heldRun = (yield* store.getThreadRecords(heldThreadId, ["runs"])).runs.find(
        (r) => r.userMessageId === "held-first",
      )!;
      yield* writer.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("manual-stop"),
        threadId: heldThreadId,
        runId: heldRun.id,
        holdQueue: true,
      });
      yield* execution.hold({
        threadId: heldThreadId,
        operationId: "move:held",
        action: "acquire",
        sourceLocation: source,
      });
      yield* execution.quiesce({ threadId: heldThreadId, operationId: "move:held" });
      yield* execution.hold({
        threadId: heldThreadId,
        operationId: "move:held",
        action: "release",
      });
      assert.isTrue((yield* store.getQueuedRunPage(heldThreadId)).entries[0]!.held);
    }).pipe(Effect.provide(layer)),
);

it.live(
  "a reconstructed quiesce still waits for physical detach after its binding disappeared",
  () =>
    Effect.gen(function* () {
      const writer = yield* OrchestratorV2,
        store = yield* ProjectionStoreV2,
        outbox = yield* EffectOutboxV2;
      const threadId = yield* create("thread:physical");
      const now = yield* DateTime.now;
      const sessionId = ProviderSessionId.make("session:physical");
      yield* store.apply({
        type: "provider-session.attached",
        id: EventId.make("attach:physical"),
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: source.cwd,
          model: "gpt-5.4",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      const execution = yield* make;
      yield* execution.hold({
        threadId,
        operationId: "move:physical",
        action: "acquire",
        sourceLocation: source,
      });
      yield* writer.dispatch({
        type: "provider-session.detach",
        commandId: CommandId.make("detach:lost-ack"),
        threadId,
        providerSessionId: sessionId,
        revokeMcpCredential: true,
      });
      assert.isNull((yield* store.getExecutionActors(threadId)).items[0]!.providerSessionId);
      const barrier = yield* store.getExecutionDetachBarrier(threadId);
      assert.isNotNull(barrier);
      const restarted = yield* make;
      assert.equal(
        (yield* restarted
          .hold({ threadId, operationId: "move:physical", action: "release" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* writer.dispatch(send(threadId, "too-early")).pipe(Effect.result))._tag,
        "Failure",
      );
      const waiting = yield* Effect.forkChild(
        restarted.quiesce({ threadId, operationId: "move:physical" }),
      );
      yield* Effect.sleep("50 millis");
      assert.isUndefined(waiting.pollUnsafe());
      const claimed = yield* outbox.claimNext({ workerId: "test", leaseDurationMs: 10_000 });
      assert.isTrue(Option.isSome(claimed));
      yield* outbox.succeed({ effectId: Option.getOrThrow(claimed).id, workerId: "test" });
      yield* Fiber.join(waiting);
      assert.isNull(yield* store.getExecutionDetachBarrier(threadId));
      yield* restarted.hold({ threadId, operationId: "move:physical", action: "release" });
      yield* writer.dispatch(send(threadId, "too-early"));
    }).pipe(Effect.provide(layer)),
);

it.live(
  "explicit recovery retries the same failed or cancelled retirement once and waits for its acknowledgement",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2,
        sql = yield* SqlClient.SqlClient;
      for (const status of ["failed", "cancelled"] as const) {
        const threadId = yield* create(`thread:retry:${status}`);
        const operationId = `move:retry:${status}`;
        const effectId = `effect:${operationId}:detach`;
        const commandId = CommandId.make(operationId);
        const execution = yield* make;
        yield* execution.hold({ threadId, operationId, action: "acquire", sourceLocation: source });
        yield* outbox.enqueue([
          {
            id: effectId,
            commandId,
            threadId,
            request: {
              type: "provider-session.detach",
              providerSessionId: ProviderSessionId.make(`session:${status}`),
              revokeMcpCredential: true,
            },
          },
        ]);
        if (status === "failed") {
          const first = Option.getOrThrow(
            yield* outbox.claimNext({ workerId: "first", leaseDurationMs: 10_000 }),
          );
          assert.equal(first.id, effectId);
          yield* outbox.fail({ effectId, workerId: "first", error: "Native source still running" });
        } else
          yield* outbox.cancelUnsettled({
            threadId,
            effectTypes: ["provider-session.detach"],
            reason: "Stopped before physical retirement",
          });
        yield* sql`UPDATE orchestration_v2_effect_outbox SET completed_at='2000-01-01T00:00:00.000Z' WHERE effect_id=${effectId}`;
        assert.equal(yield* outbox.pruneSettled, 0, "Unresolved retirement proof cannot expire");
        assert.isFalse(
          yield* outbox.retryReplaySafe({
            effectId,
            effectType: "checkpoint.capture",
            expectedStatus: status,
          }),
        );
        const wait = yield* execution.quiesce({ threadId, operationId }).pipe(Effect.forkChild);
        yield* Effect.sleep("25 millis");
        const retry = Option.getOrThrow(
          yield* outbox.claimNext({ workerId: "retry", leaseDurationMs: 10_000 }),
        );
        assert.equal(retry.id, effectId);
        assert.equal(retry.commandId, commandId);
        assert.isUndefined(wait.pollUnsafe());
        assert.equal(
          (yield* execution.hold({ threadId, operationId, action: "release" }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        yield* outbox.fail({
          effectId,
          workerId: "retry",
          error: "Native retirement remains uncertain",
        });
        assert.equal(
          (yield* Fiber.join(wait).pipe(Effect.result))._tag,
          "Failure",
          "A failed explicit attempt must not loop automatically",
        );
        const failed = Option.getOrThrow(yield* outbox.get(effectId));
        assert.equal(failed.status, "failed");
        const again = yield* execution.quiesce({ threadId, operationId }).pipe(Effect.forkChild);
        yield* Effect.sleep("25 millis");
        const final = Option.getOrThrow(
          yield* outbox.claimNext({ workerId: "final", leaseDurationMs: 10_000 }),
        );
        assert.equal(final.id, effectId);
        assert.equal(final.commandId, commandId);
        assert.equal(final.attemptCount, failed.attemptCount + 1);
        assert.equal(
          (yield* execution.hold({ threadId, operationId, action: "release" }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        yield* outbox.succeed({ effectId, workerId: "final" });
        yield* Fiber.join(again);
        assert.isFalse(
          yield* outbox.retryReplaySafe({
            effectId,
            effectType: "provider-session.detach",
            expectedStatus: "failed",
          }),
        );
        assert.isNull(yield* (yield* ProjectionStoreV2).getExecutionDetachBarrier(threadId));
        yield* execution.hold({ threadId, operationId, action: "release" });
      }
    }).pipe(Effect.provide(layer)),
);

it.live("confirms native retirement before an active Run can be synthetically interrupted", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2,
      writer = yield* OrchestratorV2,
      outbox = yield* EffectOutboxV2;
    const threadId = yield* create("thread:retirement-order");
    const execution = yield* make;
    yield* execution.hold({
      threadId,
      operationId: "move:order",
      action: "acquire",
      sourceLocation: source,
    });
    const calls: string[] = [];
    let settled = false;
    const observed = yield* make.pipe(
      Effect.provideService(ProjectionStoreV2, {
        ...store,
        getExecutionActors: () =>
          Effect.succeed({
            items: [
              {
                threadId,
                activeRunId: settled ? null : RunId.make("run:order"),
                providerSessionId: settled ? null : ProviderSessionId.make("session:order"),
              },
            ],
            nextCursor: null,
          }),
      }),
      Effect.provideService(OrchestratorV2, {
        ...writer,
        dispatch: (command) =>
          Effect.gen(function* () {
            calls.push(command.type);
            if (command.type === "run.interrupt") settled = true;
            if (command.type === "provider-session.detach")
              yield* outbox
                .enqueue([
                  {
                    id: `effect:${command.commandId}:provider-session.detach:${command.providerSessionId}`,
                    commandId: command.commandId,
                    threadId,
                    request: {
                      type: "provider-session.detach",
                      providerSessionId: command.providerSessionId,
                    },
                  },
                ])
                .pipe(Effect.orDie);
            return { sequence: 0, storedEvents: [] };
          }),
      }),
    );
    const waiting = yield* observed
      .quiesce({ threadId, operationId: "move:order" })
      .pipe(Effect.forkChild);
    yield* Effect.sleep("25 millis");
    assert.deepEqual(calls, ["provider-session.detach"]);
    const claim = Option.getOrThrow(
      yield* outbox.claimNext({ workerId: "retirement", leaseDurationMs: 10_000 }),
    );
    assert.deepEqual(calls, ["provider-session.detach"]);
    yield* outbox.succeed({ effectId: claim.id, workerId: "retirement" });
    yield* Fiber.join(waiting);
    assert.deepEqual(calls, [
      "provider-session.detach",
      "provider-session.detach",
      "run.interrupt",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "admits actor pages before decoding history and replays a partially committed child location",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2,
        sql = yield* SqlClient.SqlClient;
      const threadId = yield* create("thread:pressure");
      const execution = yield* make;
      yield* execution.hold({
        threadId,
        operationId: "move:pressure",
        action: "acquire",
        sourceLocation: source,
      });
      // Storage pressure is deliberately separate from the public admission path above.
      yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,payload_json)
    SELECT 'child:pressure',project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,
      json_set(payload_json,'$.id','child:pressure','$.worktreePath',${source.cwd + "/child"},'$.executionHandoff',NULL,'$.lineage.rootThreadId',${threadId},'$.lineage.parentThreadId',${threadId},'$.lineage.relationshipToParent','subagent')
    FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
      yield* sql`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<1000)
    INSERT INTO orchestration_v2_projection_provider_session_bindings(provider_session_id,thread_id)
    SELECT 'cold:session:'||printf('%04d',value),${threadId} FROM n`;
      const coldBody = "COLD_BODY" + "x".repeat(64 * 1024);
      yield* sql`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<1000)
    INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,completed_at,payload_json)
    SELECT 'cold:run:'||value,${threadId},value,'codex',NULL,'completed','2026-10-15T00:00:00.000Z','2026-10-15T00:00:00.000Z',
      json_object('coldBody',${coldBody}) FROM n`;
      const parses: string[] = [];
      const original = JSON.parse;
      const spy = vi
        .spyOn(JSON, "parse")
        .mockImplementation((...args: Parameters<typeof JSON.parse>) => {
          parses.push(args[0]);
          return original(...args);
        });
      try {
        const page = yield* store.getExecutionActors(threadId);
        assert.lengthOf(page.items, 64);
        assert.isNotNull(page.nextCursor);
        assert.isTrue(parses.every((raw) => !raw.includes("COLD_BODY")));
        yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id=${threadId}`;
        // A crash after a child's path commits leaves root as the canonical source boundary.
        const target = {
          ...source,
          cwd: "/tmp/move-target",
          workspaceRoots: ["/tmp/move-target"],
          managedWorktreePath: "/tmp/move-target",
        };
        yield* execution.commit({
          threadId,
          operationId: "move:pressure",
          location: target,
          sourceWorkspaceRoot: source.workspaceRoots[0],
          childrenOnly: true,
        });
        assert.equal((yield* store.getThread(threadId)).worktreePath, source.cwd);
        assert.equal(
          (yield* store.getThread(ThreadId.make("child:pressure"))).worktreePath,
          "/tmp/move-target/child",
        );
        const restarted = yield* make;
        yield* restarted.commit({ threadId, operationId: "move:pressure", location: target });
        yield* restarted.commit({ threadId, operationId: "move:pressure", location: target });
        assert.equal((yield* store.getThread(threadId)).worktreePath, target.cwd);
        yield* execution.commit({
          threadId,
          operationId: "move:pressure",
          location: source,
          sourceWorkspaceRoot: target.workspaceRoots[0],
          childrenOnly: true,
        });
        assert.equal(
          (yield* store.getThread(ThreadId.make("child:pressure"))).worktreePath,
          source.cwd + "/child",
        );
        yield* execution.commit({ threadId, operationId: "move:pressure", location: source });
        assert.equal((yield* store.getThread(threadId)).worktreePath, source.cwd);
        assert.equal((yield* store.getExecutionHandoffs()).items[0]?.operationId, "move:pressure");
        const plan = yield* sql<{
          detail: string;
        }>`EXPLAIN QUERY PLAN SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json,'$.lineage.rootThreadId')=${threadId} ORDER BY thread_id LIMIT 65`;
        assert.isTrue(plan.some((row) => row.detail.includes("execution_root_idx")));
        assert.isTrue(
          parses.every((raw) => !raw.includes("COLD_BODY")),
          "Actual partial/root commit must not decode historical Run bodies",
        );
      } finally {
        spy.mockRestore();
      }
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "rechecks the exact native retirement receipt and workspace hold in the commit transaction",
  () =>
    Effect.gen(function* () {
      const writer = yield* OrchestratorV2;
      const store = yield* ProjectionStoreV2;
      const outbox = yield* EffectOutboxV2;
      const sink = yield* EventSink.EventSinkV2;
      const execution = yield* make;
      const threadId = yield* create("thread:retirement-proof");
      yield* writer.dispatch(send(threadId, "proof-input"));
      yield* execution.hold({
        threadId,
        operationId: "proof:move",
        action: "acquire",
        sourceLocation: source,
      });
      const records = yield* store.getExecutionRetirementContext(
        threadId,
        (yield* store.getExecutionActors(threadId)).items[0]!.activeRunId!,
      );
      const run = records.run!;
      const sessionId = ProviderSessionId.make("source:proof");
      const now = yield* DateTime.now;
      yield* store.apply({
        type: "provider-session.attached",
        id: EventId.make("proof:attached"),
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: source.cwd,
          model: "gpt-5.4",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      yield* store.apply({
        type: "provider-thread.updated",
        id: EventId.make("proof:source"),
        threadId,
        occurredAt: now,
        payload: {
          ...records.providerThread!,
          providerSessionId: sessionId,
          nativeThreadRef: { driver: adapter.driver, nativeId: "native:proof", strength: "strong" },
        },
      });
      yield* store.apply({
        type: "provider-session.detached",
        id: EventId.make("proof:detached"),
        threadId,
        occurredAt: now,
        payload: { providerSessionId: sessionId, detachedAt: now },
      });
      const effectId = "effect:proof:retirement";
      yield* outbox.enqueue([
        {
          id: effectId,
          threadId,
          commandId: CommandId.make("proof:detach"),
          request: {
            type: "provider-session.detach",
            providerSessionId: sessionId,
            revokeMcpCredential: true,
          },
        },
      ]);
      const event = {
        type: "run.execution-retired" as const,
        id: EventId.make("proof:compact"),
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          runId: run.id,
          attemptId: run.activeAttemptId,
          rootNodeId: run.rootNodeId,
          providerThreadId: run.providerThreadId,
          cohortParentRunId: run.id,
          deliveryRunId: null,
          operationId: "proof:move",
          retirementEffectId: effectId,
        },
      };
      assert.equal((yield* sink.write({ events: [event] }).pipe(Effect.result))._tag, "Failure");
      let claim = Option.getOrThrow(
        yield* outbox.claimNext({ workerId: "proof", leaseDurationMs: 10000 }),
      );
      while (claim.id !== effectId) {
        yield* outbox.succeed({ effectId: claim.id, workerId: "proof" });
        claim = Option.getOrThrow(
          yield* outbox.claimNext({ workerId: "proof", leaseDurationMs: 10000 }),
        );
      }
      assert.equal((yield* sink.write({ events: [event] }).pipe(Effect.result))._tag, "Failure");
      yield* outbox.succeed({ effectId, workerId: "proof" });
      yield* sink.write({ events: [event] });
      assert.equal(
        (yield* store.getExecutionRetirementContext(threadId, run.id)).run?.status,
        "interrupted",
      );
      yield* execution.hold({ threadId, operationId: "proof:move", action: "release" });
      assert.equal(
        (yield* sink
          .write({ events: [{ ...event, id: EventId.make("proof:late") }] })
          .pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a reconstructed quiesce settles the held source even when native terminal arrived first",
  () =>
    Effect.gen(function* () {
      const writer = yield* OrchestratorV2;
      const store = yield* ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const execution = yield* make;
      const threadId = yield* create("thread:retirement-terminal-race");
      yield* writer.dispatch(send(threadId, "terminal-race-input"));
      const run = (yield* store.getThreadRecords(threadId, ["runs"])).runs[0]!;
      const now = yield* DateTime.now;
      yield* execution.hold({
        threadId,
        operationId: "terminal-race",
        action: "acquire",
        sourceLocation: source,
      });
      yield* sink.write({
        events: [
          {
            type: "run.updated",
            id: EventId.make("native:completed-before-retire"),
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              ...run,
              status: "completed",
              completedAt: now,
              delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null },
            },
          },
        ],
      });
      assert.equal((yield* store.getExecutionActors(threadId)).items[0]?.activeRunId, run.id);
      const restarted = yield* make;
      yield* restarted.quiesce({ threadId, operationId: "terminal-race" });
      const settled = yield* store.getExecutionRetirementContext(threadId, run.id);
      assert.equal(settled.run?.status, "completed");
      assert.equal(settled.run?.delegatedCompletion?.disposition, "stopped");
      assert.isFalse(settled.isRetirementTarget);
      yield* restarted.hold({ threadId, operationId: "terminal-race", action: "release" });
    }).pipe(Effect.provide(layer)),
);
