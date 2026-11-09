import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
  type OrchestrationV2RuntimeRequest,
} from "@nodex/runtime-contracts";
import type { ThreadActiveFlag } from "@nodex/codex-app-server-protocol/v2";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { readExecution, readExecutionItemIds, waitExecution } from "./ExecutionRead.ts";
import { readSessionMetadata } from "../orchestration-v2/SessionMetadata.ts";
import { readSessionCatalog } from "../orchestration-v2/SessionCatalog.ts";

const database = Sqlite.layerMemory;
const layer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  Outbox.layer.pipe(Layer.provide(database)),
);
const threadId = ThreadId.make("thread:exact-wait");
const instanceId = ProviderInstanceId.make("codex");
const setup = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project:wait"),
    title: "Wait",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:create"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  const put = Effect.fnUntraced(function* (
    id: string,
    ordinal: number,
    status: OrchestrationV2Run["status"],
    parent?: string,
  ) {
    const run: OrchestrationV2Run = {
      id: RunId.make(id),
      threadId,
      ordinal,
      providerInstanceId: instanceId,
      modelSelection: thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${id}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: null,
      completedAt: ["completed", "cancelled", "failed"].includes(status) ? now : null,
      checkpointId: null,
      contextHandoffId: null,
      ...(parent === undefined ? {} : { restartContinuationOfRunId: RunId.make(parent) }),
    };
    yield* store.apply({
      id: EventId.make(`event:${id}:${status}`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: run,
    });
    return run;
  });
  return { put };
});

it.effect(
  "pins exact Runs, follows only their continuation chain, and resolves steered message ownership",
  () =>
    Effect.gen(function* () {
      const { put } = yield* setup;
      yield* put("run:first", 1, "cancelled");
      yield* put("run:continued", 2, "cancelled", "run:first");
      yield* put("run:tip", 3, "running", "run:continued");
      yield* put("run:unrelated", 4, "queued");
      const exact = yield* readExecution({ threadId, runId: "run:first" });
      assert.equal(exact.selectedRunId, "run:first");
      assert.equal(exact.runId, "run:tip");
      assert.equal(exact.status, "running");
      assert.equal((yield* readExecution({ threadId })).runId, "run:unrelated");
      assert.equal((yield* readExecution({ threadId, runId: null })).runId, null);
      assert.equal(
        (yield* readExecution({ threadId, runId: "missing" }).pipe(Effect.flip)).reason,
        "run_unavailable",
      );
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      yield* store.apply({
        id: EventId.make("event:steer"),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: MessageId.make("message:steered"),
          threadId,
          runId: RunId.make("run:tip"),
          nodeId: null,
          role: "user",
          createdBy: "user",
          creationSource: "web",
          text: "Change direction",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      assert.equal(
        (yield* readExecution({ threadId, messageId: "message:steered" })).selectedRunId,
        "run:tip",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("replays a completion recorded between baseline and subscription", () =>
  Effect.gen(function* () {
    const { put } = yield* setup;
    yield* put("run:first", 1, "running");
    const initial = yield* readExecution({ threadId });
    let baseline = false;
    const fake = {
      getThreadEventSequence: () =>
        Effect.sync(() => {
          baseline = true;
          return 4;
        }),
      streamStoredEventsFrom: (input: { afterSequence?: number }) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            assert.isTrue(baseline);
            assert.equal(input.afterSequence, 4);
            yield* put("run:first", 1, "completed");
          }),
        ),
    } as unknown as OrchestratorV2["Service"];
    const result = yield* waitExecution({
      threadId,
      runId: initial.selectedRunId,
      afterRevision: initial.revision,
      timeoutMs: 1000,
    }).pipe(Effect.provideService(OrchestratorV2, fake));
    assert.equal(result.status, "completed");
  }).pipe(Effect.provide(layer)),
);

it.effect("wakes when a declined restart continuation settles without a domain event", () =>
  Effect.gen(function* () {
    const { put } = yield* setup;
    yield* put("run:first", 1, "cancelled");
    const outbox = yield* Outbox.EffectOutboxV2;
    const effectId = "effect:restart-continuation:run:first";
    yield* outbox.enqueue([
      {
        id: effectId,
        commandId: CommandId.make("command:restart"),
        threadId,
        request: { type: "provider-runtime.continue", sourceRunId: RunId.make("run:first") },
      },
    ]);
    const claimed = yield* outbox.claimNext({ workerId: "worker", leaseDurationMs: 10000 });
    assert.isTrue(Option.isSome(claimed));
    const initial = yield* readExecution({ threadId });
    assert.isTrue(initial.continuationPending);
    const subscribed = yield* Deferred.make<void>();
    const fake = {
      getThreadEventSequence: () => Effect.succeed(1),
      streamStoredEventsFrom: () =>
        Stream.fromEffect(
          Deferred.succeed(subscribed, undefined).pipe(Effect.andThen(Effect.never)),
        ),
    } as unknown as OrchestratorV2["Service"];
    const waiting = yield* waitExecution({
      threadId,
      runId: initial.selectedRunId,
      afterRevision: initial.revision,
      timeoutMs: 120000,
    }).pipe(Effect.provideService(OrchestratorV2, fake), Effect.forkChild);
    yield* Deferred.await(subscribed);
    yield* outbox.succeed({ effectId, workerId: "worker" });
    const result = yield* Fiber.join(waiting);
    assert.equal(result.runId, "run:first");
    assert.isFalse(result.continuationPending);
  }).pipe(Effect.provide(layer)),
);

it.effect("reports deleted Threads at a timeout and never repins to a newer Run", () =>
  Effect.gen(function* () {
    const { put } = yield* setup;
    yield* put("run:first", 1, "running");
    const initial = yield* readExecution({ threadId });
    const ready = yield* Deferred.make<void>();
    const fake = {
      getThreadEventSequence: () => Effect.succeed(1),
      streamStoredEventsFrom: () =>
        Stream.fromEffect(Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never))),
    } as unknown as OrchestratorV2["Service"];
    const waiting = yield* waitExecution({
      threadId,
      runId: initial.selectedRunId,
      afterRevision: initial.revision,
      timeoutMs: 1000,
    }).pipe(Effect.provideService(OrchestratorV2, fake), Effect.result, Effect.forkChild);
    yield* Deferred.await(ready);
    yield* put("run:other", 2, "completed");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-10-27' WHERE thread_id = ${threadId}`;
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(waiting);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure" && "reason" in result.failure)
      assert.equal(result.failure.reason, "thread_unavailable");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "releases interrupted settlement waiters and wakes all remaining clients after cancellation commits",
  () =>
    Effect.gen(function* () {
      const outbox = yield* Outbox.EffectOutboxV2;
      const effectId = "effect:restart-continuation:run:first";
      yield* outbox.enqueue([
        {
          id: effectId,
          commandId: CommandId.make("command:restart"),
          threadId,
          request: { type: "provider-runtime.continue", sourceRunId: RunId.make("run:first") },
        },
      ]);
      const interrupted = yield* outbox.awaitSettled(effectId).pipe(Effect.forkChild);
      const first = yield* outbox.awaitSettled(effectId).pipe(Effect.forkChild);
      const second = yield* outbox.awaitSettled(effectId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(interrupted);
      const ids = yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-runtime.continue"],
        reason: "declined",
      });
      yield* outbox.signalCancellations(ids);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* outbox.awaitSettled("effect:already-pruned");
    }).pipe(Effect.provide(layer)),
);

it.effect("keeps attention and compact progress scoped to the selected Run", () =>
  Effect.gen(function* () {
    const { put } = yield* setup;
    yield* put("run:first", 1, "running");
    yield* put("run:other", 2, "waiting");
    const sql = yield* SqlClient.SqlClient;
    // This fixture targets the indexed execution query boundary: unrelated payloads are
    // deliberately opaque, so the read cannot accidentally hydrate a whole timeline.
    for (const [index, runId] of ["run:first", "run:other"].entries()) {
      const node = `node:${index}`;
      yield* sql`INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,root_node_id,kind,status,payload_json)
        VALUES(${node},${threadId},${runId},${node},'tool','waiting','{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json)
        VALUES(${`request:${index}`},${threadId},${node},${index ? "approval" : "user_input"},'pending','2026-10-27','{"responseCapability":{"type":"live"}}')`;
      for (const [ordinal, type] of ["assistant_message", "command"].entries()) {
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json)
          VALUES(${`item:${index}:${type}`},${threadId},${runId},${index * 10 + ordinal},${type},'completed','2026-10-27','{}')`;
      }
    }
    for (const kind of ["dynamic_tool_call", "auth_refresh"]) {
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json)
        VALUES(${`request:${kind}`},${threadId},'node:0',${kind},'pending','2027-01-01','{}')`;
    }
    const selected = yield* readExecution({ threadId, runId: "run:first" });
    assert.deepEqual(selected.activeFlags, ["waitingOnUserInput"]);
    const ids = yield* readExecutionItemIds(threadId, RunId.make("run:first"));
    assert.equal(ids.replyId, "item:0:assistant_message");
    assert.equal(ids.activity?.turn_item_id, "item:0:command");
    yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status='resolved' WHERE runtime_request_id='request:0'`;
    const resolved = yield* readExecution({ threadId, runId: "run:first" });
    assert.deepEqual(resolved.activeFlags, []);
    assert.notEqual(resolved.revision, selected.revision);
    // Streaming an earlier item still counts as progress when the latest ordinal is unchanged.
    yield* sql`UPDATE orchestration_v2_projection_turn_items SET updated_at='2026-10-28' WHERE turn_item_id='item:0:assistant_message'`;
    const streamed = yield* readExecution({ threadId, runId: "run:first" });
    assert.notEqual(streamed.revision, resolved.revision);
    yield* sql`UPDATE orchestration_v2_projection_turn_items SET updated_at='2026-10-29' WHERE run_id='run:other'`;
    assert.equal(
      (yield* readExecution({ threadId, runId: "run:first" })).revision,
      streamed.revision,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "shares attention flags across Runtime catalog, metadata and exact-Run observations",
  () =>
    Effect.gen(function* () {
      const { put } = yield* setup;
      const run = yield* put("run:attention", 1, "running");
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const nodeId = NodeId.make("node:attention");
      yield* store.apply({
        id: EventId.make("event:attention-node"),
        type: "node.updated",
        threadId,
        runId: run.id,
        nodeId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId: run.id,
          rootNodeId: nodeId,
          parentNodeId: null,
          kind: "tool_call",
          status: "waiting",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      let event = 0;
      const request = (
        kind: OrchestrationV2RuntimeRequest["kind"],
        status: "pending" | "resolved" = "pending",
        responseCapability: OrchestrationV2RuntimeRequest["responseCapability"] = {
          type: "live",
          providerSessionId: ProviderSessionId.make("provider:attention"),
        },
      ) =>
        store.apply({
          id: EventId.make(`event:attention:${event++}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(`request:${kind}`),
            nodeId,
            kind,
            status,
            providerTurnId: null,
            nativeRequestRef: null,
            responseCapability,
            createdAt: now,
            resolvedAt: status === "resolved" ? now : null,
          },
        });
      const assertFlags = Effect.fnUntraced(function* (expected: readonly ThreadActiveFlag[]) {
        const execution = yield* readExecution({ threadId, runId: run.id });
        const metadata = yield* readSessionMetadata([threadId]);
        const catalog = yield* readSessionCatalog({});
        assert.deepEqual(execution.activeFlags, expected);
        assert.deepEqual(metadata[0]?.activeFlags, expected);
        assert.deepEqual(catalog.items[0]?.activeFlags, expected);
        return execution;
      });
      for (const kind of [
        "command",
        "file-read",
        "file-change",
        "mcp-elicitation",
        "permission",
        "user_input",
        "dynamic_tool_call",
        "auth_refresh",
      ] as const) {
        yield* request(kind);
        yield* assertFlags(
          kind === "user_input"
            ? ["waitingOnUserInput"]
            : kind === "dynamic_tool_call" || kind === "auth_refresh"
              ? []
              : ["waitingOnApproval"],
        );
        yield* request(kind, "resolved");
        yield* assertFlags([]);
      }
      const secret = (status: "waiting" | "completed") =>
        store.apply({
          id: EventId.make(`event:secret:${event++}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("secret:attention"),
            threadId,
            runId: run.id,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            type: "secret_request",
            status,
            title: "API key",
            label: "API key",
            reason: "Connect the service",
            secretStatus: status === "waiting" ? "pending" : "saved",
            startedAt: now,
            completedAt: status === "completed" ? now : null,
            updatedAt: now,
          },
        });
      yield* request("user_input", "pending", { type: "message" });
      const working = yield* assertFlags([]);
      yield* put("run:attention", 1, "waiting");
      const awaiting = yield* assertFlags(["waitingOnUserInput"]);
      assert.notEqual(awaiting.revision, working.revision);
      yield* request("permission");
      yield* assertFlags(["waitingOnApproval", "waitingOnUserInput"]);
      yield* request("permission", "resolved");
      yield* request("user_input", "resolved", { type: "message" });
      yield* secret("waiting");
      yield* assertFlags(["waitingOnUserInput"]);
      yield* secret("completed");
      yield* assertFlags([]);
      yield* secret("waiting");
      yield* assertFlags(["waitingOnUserInput"]);
      yield* put("run:attention", 1, "completed");
      // A retained secret on a terminal Run does not need the person's attention.
      yield* assertFlags([]);
      yield* request("user_input", "pending", { type: "message" });
      yield* assertFlags(["waitingOnUserInput"]);
      // A newer working Run on the same Thread suppresses its older asynchronous question.
      yield* put("run:newer", 2, "running");
      const resumed = yield* assertFlags([]);
      yield* put("run:newer", 2, "waiting");
      const stopped = yield* assertFlags(["waitingOnUserInput"]);
      assert.notEqual(stopped.revision, resumed.revision);
      yield* request("user_input", "resolved", { type: "message" });
      yield* assertFlags([]);
    }).pipe(Effect.provide(layer)),
);
