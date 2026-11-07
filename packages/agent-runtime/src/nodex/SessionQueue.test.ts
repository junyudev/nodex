import { readModelPolicyFailure } from "../../../../src/shared/model-policy.ts";
import { make as makeStop } from "./SessionStop.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  ThreadManagementService,
  layer as management,
} from "../orchestration-v2/ThreadManagementService.ts";
import type { ProviderAdapterV2 } from "@nodex/provider-core/server/ProviderAdapter";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { queuedRunsInDeliveryOrder } from "../orchestration-v2/QueuedRunOrder.ts";
import { make, type SessionQueueInput } from "./SessionQueue.ts";

const database = SqlitePersistence.layerMemory;
const adapter = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider work in queue tests"),
} as ProviderAdapterV2["Service"];
const layer = management.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "session-queue" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(database))),
);
const threadId = ThreadId.make("thread");
const setup = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("project"),
    title: "Queue",
    modelSelection: { instanceId: adapter.instanceId, model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("active"),
    threadId,
    messageId: MessageId.make("active"),
    text: "working",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "start_immediately" },
  });
  const send = (id: string, text: string, automatic = false) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${id}`),
      threadId,
      messageId: MessageId.make(id),
      text,
      attachments: [
        {
          type: "image",
          id: `image_${id}`,
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ],
      createdBy: automatic ? "agent" : "user",
      creationSource: automatic ? "server" : "web",
      dispatchMode: { type: "queue_after_active" },
      ...(automatic
        ? {
            notification: {
              source: { kind: "background_task" as const },
              outcome: "updated" as const,
              summary: "Task update",
            },
          }
        : {}),
    });
  // Projection fixtures model both durable delivery markers without needing native execution.
  const markCompletion = Effect.fnUntraced(function* (messageId: string) {
    const projection = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
    const message = projection.messages.find((message) => message.id === messageId)!;
    const { notification: _notice, ...original } = message;
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`completion:${messageId}`),
          threadId,
          type: "message.updated",
          occurredAt: message.updatedAt,
          payload: {
            ...original,
            delegatedCompletion: {
              parentRunId: projection.runs[0]!.id,
              generation: 1,
              taskIds: [NodeId.make("task")],
            },
          },
        },
      ],
    });
  });
  const queue = yield* make;
  let counter = 0;
  const call = (input: Omit<SessionQueueInput, "threadId" | "commandId">) =>
    queue({ ...input, threadId, commandId: CommandId.make(`queue:${++counter}`) });
  const queued = Effect.fnUntraced(function* (messageId: string) {
    const projection = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
    return projection.runs.find((run) => run.userMessageId === messageId)!.id;
  });
  return { send, call, queued, orchestrator, queue, markCompletion };
});

it.effect("pages in send order, bounds Unicode text and retains attachments when edited", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.send("one", "😀".repeat(7000));
    yield* f.send("two", "second");
    const first = yield* f.call({ action: "list", limit: 1 });
    assert.isTrue("items" in first);
    if (!("items" in first)) return;
    assert.equal(first.items[0]?.text, "😀".repeat(250));
    assert.isTrue(first.items[0]?.truncated);
    const next = yield* f.call({ action: "list", limit: 1, cursor: first.nextCursor! });
    if (!("items" in next)) throw new Error("Expected a queue page");
    assert.equal(next.items[0]?.text, "second");
    assert.isNull(next.nextCursor);
    const queuedId = yield* f.queued("one");
    const read = yield* f.call({ action: "read", queuedId });
    if (!("queuedId" in read)) throw new Error("Expected a queued message");
    assert.equal(read.text, "😀".repeat(6000));
    assert.isTrue(read.truncated);
    const before = yield* f.orchestrator.getThreadRecords(threadId, ["messages"]);
    yield* f.call({ action: "edit", queuedId, text: "replacement" });
    const after = yield* f.orchestrator.getThreadRecords(threadId, ["messages"]);
    assert.deepEqual(
      after.messages.find((message) => message.id === "one")?.attachments,
      before.messages.find((message) => message.id === "one")?.attachments,
    );
    assert.equal(after.messages.find((message) => message.id === "one")?.text, "replacement");
    assert.isTrue(yield* f.call({ action: "list", cursor: "invalid" }).pipe(Effect.isFailure));
  }).pipe(Effect.provide(layer)),
);

it.effect("reorders pending messages, protects automatic notices and rejects stale writes", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.send("one", "one");
    yield* f.send("two", "two");
    yield* f.send("notice", "automatic", true);
    const one = yield* f.queued("one"),
      two = yield* f.queued("two"),
      notice = yield* f.queued("notice");
    for (const action of ["edit", "remove", "reorder", "steer"] as const) {
      const result = yield* f
        .call({ action, queuedId: notice, text: "changed", beforeId: null })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.equal((result.failure as { reason: string }).reason, "protected_entry");
    }
    yield* f.call({ action: "reorder", queuedId: two, beforeId: one });
    const page = yield* f.call({ action: "list" });
    if (!("items" in page)) throw new Error("Expected page");
    assert.deepEqual(
      page.items.map((item) => item.queuedId),
      [two, one, notice],
    );
    assert.equal(page.items[2]?.kind, "notification");
    yield* f.call({ action: "remove", queuedId: one });
    for (const action of ["read", "edit", "remove", "reorder", "steer"] as const) {
      const result = yield* f
        .call({ action, queuedId: one, text: "late", beforeId: null })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.equal((result.failure as { reason: string }).reason, "not_queued");
    }
    // Internal lifecycle cancellation can retire a notice; the user queue cannot.
    yield* f.orchestrator.dispatch({
      type: "queued-run.cancel-internal",
      commandId: CommandId.make("retire-notice"),
      threadId,
      runId: notice,
    });
    const owner = yield* ThreadManagementService;
    const remaining = yield* f.queued("two");
    const parent = yield* f.orchestrator.getThreadRecords(threadId, ["runs"]);
    yield* owner.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("finish-active"),
      threadId,
      runId: parent.runs[0]!.id,
    });
    yield* owner.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("start-queued"),
      threadId,
      runId: remaining,
    });
    assert.isTrue(
      yield* f
        .call({ action: "edit", queuedId: remaining, text: "started" })
        .pipe(Effect.isFailure),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "Session Stop holds queued work, stops delegated children, and replays without touching later work",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.send("queued", "later");
      const root = yield* f.orchestrator.getThreadProjection(threadId);
      const active = root.runs[0]!;
      yield* f.orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate"),
        parentThreadId: threadId,
        parentRunId: active.id,
        parentNodeId: active.rootNodeId!,
        task: "child task",
        modelSelection: { instanceId: adapter.instanceId, model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const delegated = yield* f.orchestrator.getThreadProjection(threadId);
      const childId = delegated.subagents[0]!.childThreadId!;
      const stop = yield* makeStop;
      const command = {
        threadId,
        commandId: CommandId.make("stop"),
        reason: "Stopped by another agent",
      };
      assert.isTrue((yield* stop(command)).stopped);
      const stopped = yield* f.orchestrator.getThreadProjection(threadId);
      assert.equal(stopped.runs[0]?.status, "interrupted");
      assert.isTrue(stopped.runs.find((run) => run.userMessageId === "queued")?.queueHeld);
      assert.equal(
        (yield* f.orchestrator.getThreadProjection(childId)).runs[0]?.status,
        "interrupted",
      );
      assert.isTrue(
        stopped.turnItems.some(
          (item) =>
            item.type === "run_interrupt_request" && item.message === "Stopped by another agent",
        ),
      );
      yield* f.orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("later-work"),
        threadId,
        messageId: MessageId.make("later-work"),
        text: "new work",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const later = (yield* f.orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      yield* stop(command);
      assert.equal(
        (yield* f.orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
        later.status,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("carries queue and Stop caller ceilings to command admission", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.send("limited", "original");
    const queuedId = yield* f.queued("limited");
    const modeLimit = {
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
    };
    const stop = yield* makeStop;
    for (const effect of [
      f
        .call({ action: "edit", queuedId, text: "unsafe replacement", modeLimit })
        .pipe(Effect.result),
      f.call({ action: "steer", queuedId, modeLimit }).pipe(Effect.result),
      stop({ threadId, commandId: CommandId.make("stop:limited"), modeLimit }).pipe(Effect.result),
    ]) {
      const result = yield* effect;
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.propertyVal(result.failure, "_tag", "OrchestratorThreadAboveModeLimitError");
    }
    const projection = yield* f.orchestrator.getThreadProjection(threadId);
    assert.equal(projection.messages.find((message) => message.id === "limited")?.text, "original");
    assert.equal(projection.runs.find((run) => run.id === queuedId)?.status, "queued");
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["edit", "steer", "stop"] as const)(
  "rechecks %s after a target widens while waiting for its command lock",
  (action) =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.send("race", "original");
      yield* f.orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        threadId,
        commandId: CommandId.make("narrow"),
        runtimeMode: "approval-required",
      });
      const queuedId = yield* f.queued("race");
      const initial = (yield* f.orchestrator.getThreadProjection(threadId)).thread;
      const events = yield* EventSink.EventSinkV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      const mutation = yield* executor
        .withLock(
          threadId,
          Effect.gen(function* () {
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(release);
            yield* events.write({
              events: [
                {
                  id: EventId.make("widen:queue"),
                  type: "thread.metadata-updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...initial, runtimeMode: "full-access" },
                },
              ],
            });
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(locked);
      const stop = yield* makeStop;
      const modeLimit = {
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
      };
      const attempt = yield* Effect.gen(function* () {
        yield* Deferred.succeed(waiting, undefined);
        if (action === "stop") {
          return yield* stop({ threadId, commandId: CommandId.make("stop:race"), modeLimit }).pipe(
            Effect.result,
          );
        }
        return yield* f
          .call({ action, queuedId, text: "replacement", modeLimit })
          .pipe(Effect.result);
      }).pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(mutation);
      const result = yield* Fiber.join(attempt);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.propertyVal(result.failure, "_tag", "OrchestratorThreadAboveModeLimitError");
      const projection = yield* f.orchestrator.getThreadProjection(threadId);
      assert.equal(projection.messages.find((message) => message.id === "race")?.text, "original");
      assert.equal(projection.runs.find((run) => run.id === queuedId)?.status, "queued");
    }).pipe(Effect.provide(Layer.merge(layer, ThreadCommandExecutor.layer))),
);

it.effect("lists delivery kinds, protects both markers and preserves internal cancellation", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.send("user", "Delegated task finished");
    yield* f.send("completion", "arbitrary words", true);
    yield* f.markCompletion("completion");
    yield* f.send("notification", "arbitrary words", true);
    const user = yield* f.queued("user");
    const completion = yield* f.queued("completion");
    const notification = yield* f.queued("notification");
    const listed = yield* f.call({ action: "list" });
    if (!("items" in listed)) throw new Error("Expected page");
    assert.deepEqual(
      listed.items.map(({ queuedId, kind }) => [queuedId, kind]),
      [
        [completion, "delegated_completion"],
        [user, "message"],
        [notification, "notification"],
      ],
    );
    const store = yield* ProjectionStore.ProjectionStoreV2;
    assert.equal((yield* store.getQueuedRunHead(threadId))?.runId, completion);
    const outbox = yield* store.getQueuedRunPage(threadId);
    assert.deepEqual(
      outbox.entries.map((entry) => entry.runId),
      [user],
    );
    const before = yield* f.orchestrator.getThreadProjection(threadId);
    const activeRun = before.runs[0]!;
    for (const [queuedId, kind] of [
      [completion, "delegated_completion"],
      [notification, "notification"],
    ] as const) {
      const read = yield* f.call({ action: "read", queuedId });
      if (!("kind" in read)) throw new Error("Expected entry");
      assert.equal(read.kind, kind);
      for (const action of ["edit", "remove", "reorder", "steer"] as const) {
        const result = yield* f
          .call({ action, queuedId, text: "changed", beforeId: null })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.propertyVal(result.failure, "reason", "protected_entry");
      }
      const targetResult = yield* f
        .call({ action: "reorder", queuedId: user, beforeId: queuedId })
        .pipe(Effect.result);
      assert.equal(targetResult._tag, "Failure");
      if (targetResult._tag === "Failure")
        assert.propertyVal(targetResult.failure, "reason", "protected_entry");
      const commands = [
        { type: "queued-run.edit", runId: queuedId, text: "changed" },
        { type: "queued-run.cancel", runId: queuedId },
        { type: "queued-run.reorder", runId: queuedId, beforeRunId: null },
        { type: "queued-run.reorder", runId: user, beforeRunId: queuedId },
        {
          type: "queued-message.promote-to-steer",
          queuedRunId: queuedId,
          targetRunId: activeRun.id,
        },
        { type: "queue.resume", runId: queuedId },
      ] as const;
      for (const [index, command] of commands.entries()) {
        const result = yield* f.orchestrator
          .dispatch({
            ...command,
            threadId,
            commandId: CommandId.make(`reject:${queuedId}:${index}`),
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.include(
            String((result.failure as { cause: unknown }).cause),
            "Runtime deliveries",
          );
        }
      }
    }
    const unchanged = yield* f.orchestrator.getThreadProjection(threadId);
    assert.deepEqual(unchanged.runs, before.runs);
    assert.deepEqual(unchanged.messages, before.messages);
    yield* f.send("second", "second");
    const second = yield* f.queued("second");
    yield* f.call({ action: "reorder", queuedId: second, beforeId: user });
    const reordered = yield* f.orchestrator.getThreadProjection(threadId);
    for (const deliveryId of [completion, notification])
      assert.deepEqual(
        reordered.runs.find((run) => run.id === deliveryId),
        before.runs.find((run) => run.id === deliveryId),
      );
    assert.deepEqual(
      queuedRunsInDeliveryOrder(reordered).map((run) => run.id),
      [completion, second, notification, user],
    );
    yield* f.orchestrator.dispatch({
      type: "queue.resume",
      threadId,
      runId: user,
      commandId: CommandId.make("send-user-now"),
    });
    const resumed = yield* f.orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      queuedRunsInDeliveryOrder(resumed).map((run) => run.id),
      [completion, user, second, notification],
    );
    // The transport schema cannot admit the runtime-only cancellation command.
    assert.throws(() =>
      Schema.decodeUnknownSync(OrchestrationV2Command)({
        type: "queued-run.cancel-internal",
        threadId,
        runId: notification,
        commandId: "forged",
      }),
    );
    yield* f.orchestrator.dispatch({
      type: "queued-run.cancel-internal",
      threadId,
      runId: notification,
      commandId: CommandId.make("internal-cancel"),
    });
    const retired = yield* f.orchestrator.getThreadProjection(threadId);
    assert.equal(retired.runs.find((run) => run.id === notification)?.status, "cancelled");
  }).pipe(Effect.provide(layer)),
);

it.effect("an Agent cannot promote a person's queued message into a Nodex turn", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    yield* f.send("credit-queued", "continue");
    const queuedId = yield* f.queued("credit-queued");
    const before = yield* f.orchestrator.getThreadProjection(threadId);
    const run = before.runs.find((row) => row.userMessageId === "active")!;
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: [
        {
          id: EventId.make("running-on-credit"),
          type: "run.updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: {
            ...run,
            modelSelection: {
              instanceId: ProviderInstanceId.make("nodex_codex_test"),
              model: "gpt-6.1-sol",
            },
          },
        },
      ],
    });
    const refused = yield* f
      .call({
        action: "steer",
        queuedId,
        requestedBy: { kind: "agent", senderThreadId: ThreadId.make("outside-agent") },
      })
      .pipe(Effect.result);
    assert.equal(refused._tag, "Failure");
    if (refused._tag === "Failure")
      assert.equal(readModelPolicyFailure(refused.failure)?.code, "credit_requires_person");
    const after = yield* f.orchestrator.getThreadProjection(threadId);
    assert.equal(
      after.runs.find((row) => row.id === queuedId)?.status,
      before.runs.find((row) => row.id === queuedId)?.status,
    );
    assert.deepEqual(after.messages, before.messages);
  }).pipe(Effect.provide(layer)),
);
