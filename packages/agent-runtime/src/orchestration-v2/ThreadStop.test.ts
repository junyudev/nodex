import * as SessionPause from "../nodex/SessionPause.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { readRootActivity } from "./ExecutionActivity.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@nodex/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: runs stay unstarted, so Stop ends them without a provider.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const encodeEffectRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));

const pullRequest = (number: number) => ({
  host: "github.com",
  repository: "acme/widgets",
  number,
});

const createWatchingThread = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* watch(threadId, number);
  });

const watch = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      ...pullRequest(number),
      watching: true,
      link: { url: `https://github.com/acme/widgets/pull/${number}`, source: "agent" },
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("a selected Run that completes before Stop arrives leaves queued work alone", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:late-stop");
    yield* createWatchingThread(threadId, 1);
    yield* send(threadId, "First", "start_immediately");
    yield* send(threadId, "Next", "queue_after_active");
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      type: "run.updated",
      id: EventId.make("event:late-stop:completed"),
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    const interrupt = {
      type: "run.interrupt",
      commandId: CommandId.make("late-stop"),
      threadId,
      runId: run.id,
      foregroundOnly: true,
      holdQueue: true,
    } as const;
    const result = yield* orchestrator.dispatch(interrupt);
    assert.deepEqual(result.storedEvents, []);
    assert.deepEqual(yield* orchestrator.dispatch(interrupt), result);
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.runs[0]?.status, "completed");
    assert.notEqual(projection.runs[1]?.queueHeld, true);
  }).pipe(Effect.provide(layerTest)),
);

/** Delegates `task` from the parent's latest run and returns the child thread. */
const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      runs: projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      watched: (projection.thread.pullRequests ?? [])
        .filter((link) => link.watch !== undefined)
        .map((link) => link.number),
    };
  });

it.effect.each(["original", "queued"] as const)(
  "cancels the whole delegated conversation using its %s task",
  (address) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const parent = ThreadId.make("thread:cancel-conversation");
      yield* createWatchingThread(parent, 1);
      yield* send(parent, "Delegate", "start_immediately");
      const child = yield* delegate(parent, "Original turn");
      const original = (yield* orchestrator.getThreadProjection(child)).runs[0]!;
      const now = yield* DateTime.now;
      yield* projections.apply({
        type: "run.updated",
        id: EventId.make("event:cancel-conversation:first-finished"),
        threadId: child,
        runId: original.id,
        occurredAt: now,
        payload: { ...original, status: "completed", startedAt: now, completedAt: now },
      });
      yield* orchestrator.recoverDelegatedTasks;
      const before = yield* orchestrator.getThreadProjection(parent);
      const settled = before.subagents[0]!;
      assert.equal(settled.status, "completed");

      yield* send(child, "Active follow-up", "start_immediately");
      const grandchild = yield* delegate(child, "Delegated by the follow-up");
      yield* send(grandchild, "Descendant follow-up", "queue_after_active");
      yield* send(child, "Queued follow-up", "queue_after_active");
      const [, active, queued] = (yield* orchestrator.getThreadProjection(child)).runs;
      const taskId = address === "original" ? settled.id : queued!.delegatedTaskId!;
      const stopped = yield* threads.cancelDelegatedTask({
        threadId: parent,
        taskId,
        runId: settled.runId!,
        commandId: CommandId.make("cancel-conversation"),
      });
      assert.deepEqual(stopped, {
        taskId,
        status: address === "original" ? "completed" : "cancelled",
      });
      assert.deepEqual((yield* threadState(child)).runs, ["completed", "interrupted", "cancelled"]);
      assert.deepEqual((yield* threadState(grandchild)).runs, ["interrupted", "cancelled"]);

      yield* orchestrator.resumeThreadQueue(child);
      yield* orchestrator.recoverDelegatedTasks;
      const after = yield* orchestrator.getThreadProjection(parent);
      assert.deepEqual(
        after.subagents.find((task) => task.id === settled.id),
        settled,
      );
      const activeTask = after.subagents.find((task) => task.id === active!.delegatedTaskId);
      const queuedTask = after.subagents.find((task) => task.id === queued!.delegatedTaskId);
      assert.deepEqual([activeTask?.status, queuedTask?.status], ["interrupted", "cancelled"]);
      assert.deepEqual(
        [activeTask?.completionDelivery?.state, queuedTask?.completionDelivery?.state],
        ["disposed", "disposed"],
      );
      assert.deepEqual(
        after.runs.flatMap((run) => run.delegatedCompletion?.delivery?.taskIds ?? []),
        before.runs.flatMap((run) => run.delegatedCompletion?.delivery?.taskIds ?? []),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a Run-scoped stop when another Run owns an unfinished follow-up", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parent = ThreadId.make("thread:cancel-other-owner");
    yield* createWatchingThread(parent, 1);
    yield* send(parent, "First owner", "start_immediately");
    const child = yield* delegate(parent, "Original turn");
    const before = yield* orchestrator.getThreadProjection(parent);
    const original = before.subagents[0]!;
    const owner = before.runs[0]!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      type: "run.updated",
      id: EventId.make("event:cancel-other-owner:first-finished"),
      threadId: parent,
      runId: owner.id,
      occurredAt: now,
      payload: { ...owner, status: "completed", startedAt: now, completedAt: now },
    });
    yield* send(parent, "Second owner", "start_immediately");
    const nextOwner = (yield* orchestrator.getThreadProjection(parent)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("cancel-other-owner:queued"),
      threadId: child,
      messageId: MessageId.make("message:cancel-other-owner"),
      senderThreadId: parent,
      senderRunId: nextOwner.id,
      text: "Follow up",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "mcp",
    });
    const stopped = yield* threads
      .cancelDelegatedTask({
        threadId: parent,
        taskId: original.id,
        runId: owner.id,
        commandId: CommandId.make("cancel-other-owner"),
      })
      .pipe(Effect.result);
    assert.equal(stopped._tag, "Failure");
    assert.deepEqual((yield* threadState(child)).runs, ["starting", "queued"]);
    assert.isTrue(
      (yield* orchestrator.getThreadProjection(parent)).subagents.every(
        (task) => task.completionDelivery?.state !== "disposed",
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("materializes a deferred Steer task when the message starts a separate turn", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parent = ThreadId.make("thread:deferred-fallback");
    yield* createWatchingThread(parent, 1);
    yield* send(parent, "Delegate", "start_immediately");
    const child = yield* delegate(parent, "Original");
    const original = (yield* orchestrator.getThreadProjection(child)).runs[0]!;
    const owner = (yield* orchestrator.getThreadProjection(parent)).runs[0]!;
    const steer = () =>
      threads.sendToThread({
        projectId: ProjectId.make("project:thread-stop"),
        threadId: child,
        commandId: CommandId.make("command:deferred-fallback"),
        messageId: MessageId.make("message:deferred-fallback"),
        senderThreadId: parent,
        senderRunId: owner.id,
        text: "Follow up",
        attachments: [],
        mode: "steer",
        createdBy: "agent",
        creationSource: "mcp",
      });
    const deferred = yield* steer();
    assert.equal(deferred.steerTargetTaskId, original.delegatedTaskId);
    assert.isUndefined(deferred.run.delegatedTaskId);

    const now = yield* DateTime.now;
    yield* projections.apply({
      type: "run.updated",
      id: EventId.make("event:deferred-fallback:original-finished"),
      threadId: child,
      runId: original.id,
      occurredAt: now,
      payload: { ...original, status: "completed", startedAt: now, completedAt: now },
    });
    yield* orchestrator.resumeThreadQueue(child);
    const replay = yield* steer();
    assert.equal(replay.run.id, deferred.run.id);
    assert.isDefined(replay.run.delegatedTaskId);
    assert.notEqual(replay.run.delegatedTaskId, original.delegatedTaskId);
    const parentTasks = (yield* orchestrator.getThreadProjection(parent)).subagents;
    assert.equal(parentTasks.length, 2);
    assert.equal(
      parentTasks.find((task) => task.id === replay.run.delegatedTaskId)?.runId,
      owner.id,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("settles each delegated turn after its own work, even with another turn queued", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = ThreadId.make("thread:turn-settlement");
    yield* createWatchingThread(parent, 1);
    yield* send(parent, "Delegate", "start_immediately");
    const child = yield* delegate(parent, "Original");
    yield* send(child, "Follow-up", "queue_after_active");
    const [original, followup] = (yield* orchestrator.getThreadProjection(child)).runs;
    const now = yield* DateTime.now;
    const finish = (run: NonNullable<typeof original>) =>
      projections.apply({
        type: "run.updated",
        id: EventId.make(`event:finish:${run.id}`),
        threadId: run.threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", startedAt: now, completedAt: now },
      });
    const status = (taskId: NodeId) =>
      orchestrator
        .getThreadProjection(parent)
        .pipe(Effect.map(({ subagents }) => subagents.find((task) => task.id === taskId)?.status));

    yield* finish(original!);
    yield* orchestrator.recoverDelegatedTasks;
    assert.equal(yield* status(original!.delegatedTaskId!), "completed");
    assert.equal(yield* status(followup!.delegatedTaskId!), "pending");
    yield* orchestrator.resumeThreadQueue(child);

    const grandchild = yield* delegate(child, "Work owned by follow-up");
    const nested = (yield* orchestrator.getThreadProjection(grandchild)).runs[0]!;
    const activeFollowup = (yield* orchestrator.getThreadProjection(child)).runs.find(
      (run) => run.id === followup!.id,
    )!;
    yield* finish(activeFollowup);
    yield* orchestrator.recoverDelegatedTasks;
    assert.equal(yield* status(followup!.delegatedTaskId!), "pending");
    assert.isUndefined(
      yield* orchestrator.getDelegatedTaskResultRun(child, followup!.delegatedTaskId!),
    );

    yield* finish(nested);
    yield* orchestrator.recoverDelegatedTasks;
    const cursor = yield* orchestrator.getThreadEventSequence(parent);
    yield* orchestrator.dispatch({
      type: "delegated_task.completion-delivery.acknowledge",
      commandId: CommandId.make("command:acknowledge-nested"),
      parentThreadId: child,
      taskId: nested.delegatedTaskId!,
      observedByRunId: activeFollowup.id,
    });
    const settled = yield* orchestrator
      .streamStoredEventsFrom({
        threadId: parent,
        afterSequence: cursor,
        eventType: "subagent.updated",
      })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "subagent.updated" &&
            event.payload.id === followup!.delegatedTaskId &&
            event.payload.status === "completed",
        ),
        Stream.runHead,
      );
    assert.isTrue(Option.isSome(settled));
    assert.equal(yield* status(original!.delegatedTaskId!), "completed");
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["original turn", "follow-up turn", "Stop with a held wake"] as const)(
  "settles the delegated result through %s",
  (turn) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const stopHeldWake = turn === "Stop with a held wake";
      const parent = ThreadId.make("thread:completion-wake-result");
      yield* createWatchingThread(parent, 1);
      yield* send(parent, "Delegate", "start_immediately");
      const child = yield* delegate(parent, "Original");
      const latestChildRun = orchestrator
        .getThreadProjection(child)
        .pipe(Effect.map(({ runs }) => runs.at(-1)!));
      const finish = (run: OrchestrationV2Run, text: string) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                type: "message.updated",
                id: EventId.make(`event:answer:${run.id}`),
                threadId: run.threadId,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`message:answer:${run.id}`),
                  threadId: run.threadId,
                  runId: run.id,
                  nodeId: run.rootNodeId,
                  role: "assistant",
                  text,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "provider",
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                type: "run.updated",
                id: EventId.make(`event:finish:${run.id}`),
                threadId: run.threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
          yield* orchestrator.recoverDelegatedTasks;
        });
      if (turn === "follow-up turn") {
        yield* finish(yield* latestChildRun, "The original result.");
        yield* send(child, "Follow-up", "start_immediately");
      }
      const carryingRun = yield* latestChildRun;
      const taskId = carryingRun.delegatedTaskId!;
      const task = orchestrator
        .getThreadProjection(parent)
        .pipe(
          Effect.map(({ subagents }) => subagents.find((candidate) => candidate.id === taskId)!),
        );
      const finishAndWake = (owner: OrchestrationV2Run, interim: string) =>
        Effect.gen(function* () {
          const nested = yield* delegate(child, `Work from Run ${owner.ordinal}`);
          const nestedRun = (yield* orchestrator.getThreadProjection(nested)).runs[0]!;
          yield* finish(owner, interim);
          assert.isNull((yield* task).result);
          yield* finish(nestedRun, "Nested result.");
          const currentOwner = (yield* orchestrator.getThreadProjection(child)).runs.find(
            (run) => run.id === owner.id,
          )!;
          const delivery = currentOwner.delegatedCompletion?.delivery;
          assert.isNotNull(delivery);
          if (stopHeldWake) yield* send(child, "An independent follow-up", "start_immediately");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`command:completion-wake:${owner.id}`),
            threadId: child,
            messageId: delivery!.messageId,
            text: "Read the delegated result.",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
            delegatedCompletion: {
              parentRunId: owner.id,
              generation: delivery!.generation,
              taskIds: delivery!.taskIds,
            },
          });
          if (!stopHeldWake) yield* orchestrator.resumeThreadQueue(child);
          const wake = yield* latestChildRun;
          assert.notEqual(wake.id, owner.id);
          assert.isUndefined(wake.delegatedTaskId);
          if (stopHeldWake) return wake;
          assert.equal(wake.status, "starting");

          // The result may be acknowledged while the wake is still composing its answer.
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make(`command:read-result:${wake.id}`),
            parentThreadId: child,
            taskId: nestedRun.delegatedTaskId!,
            observedByRunId: wake.id,
          });
          yield* orchestrator.recoverDelegatedTasks;
          assert.isUndefined(yield* orchestrator.getDelegatedTaskResultRun(child, taskId));
          assert.isNull((yield* task).result);
          return wake;
        });

      const firstWake = yield* finishAndWake(
        carryingRun,
        "An interim answer before reading the result.",
      );
      if (stopHeldWake) {
        assert.equal(firstWake.status, "queued");
        yield* projections.apply({
          type: "run.updated",
          id: EventId.make("event:completion-wake:hold"),
          threadId: child,
          occurredAt: yield* DateTime.now,
          payload: { ...firstWake, queueHeld: true },
        });
        assert.isUndefined(yield* orchestrator.getDelegatedTaskResultRun(child, taskId));
        yield* threads.cancelDelegatedTask({
          threadId: parent,
          taskId,
          commandId: CommandId.make("command:stop-held-wake"),
        });
        assert.equal((yield* latestChildRun).status, "cancelled");
        assert.equal((yield* task).completionDelivery?.state, "disposed");
        assert.equal(
          (yield* orchestrator.getDelegatedTaskResultRun(child, taskId))?.id,
          carryingRun.id,
        );
        return;
      }
      const finalWake = yield* finishAndWake(
        firstWake,
        "An interim answer before the next result.",
      );
      const cursor = yield* orchestrator.getThreadEventSequence(parent);
      yield* finish(finalWake, "The final answer after both results.");
      const settled = yield* orchestrator
        .streamStoredEventsFrom({
          threadId: parent,
          afterSequence: cursor,
          eventType: "subagent.updated",
        })
        .pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "subagent.updated" &&
              event.payload.id === taskId &&
              event.payload.status === "completed",
          ),
          Stream.runHead,
        );
      assert.isTrue(Option.isSome(settled));
      assert.equal((yield* task).result, "The final answer after both results.");
      assert.equal(
        (yield* orchestrator.getDelegatedTaskResultRun(child, taskId))?.id,
        finalWake.id,
      );
      const { contextTransfers } = yield* orchestrator.getThreadProjection(parent);
      assert.include(
        contextTransfers.find((transfer) => transfer.subagentTaskId === taskId)?.sourcePoint,
        { runId: finalWake.id },
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("Stop ends watches, holds queues, and stops the delegated tasks under the thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const sql = yield* SqlClient.SqlClient;
    const parentThreadId = ThreadId.make("thread:stop-parent");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "first", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "child task");
    // The parent owns its pull requests; a delegated task cannot watch one.
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(childThreadId, 2))));
    const grandchildThreadId = yield* delegate(childThreadId, "grandchild task");
    yield* send(childThreadId, "child follow-up", "queue_after_active");

    // The run that delegated the child ends before the run the user stops, so
    // only a Stop that covers earlier runs keeps the stopped child from waking it.
    const now = yield* DateTime.now;
    const firstRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-parent:first-run-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: firstRun.id,
      occurredAt: now,
      payload: { ...firstRun, status: "completed", completedAt: now },
    });
    yield* send(parentThreadId, "second", "start_immediately");
    const secondRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;

    const stopCommandId = CommandId.make("stop-parent");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: stopCommandId,
      threadId: parentThreadId,
      runId: secondRun.id,
      holdQueue: true,
    });

    assert.deepEqual(yield* threadState(parentThreadId), {
      runs: ["completed", "interrupted"],
      watched: [],
    });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    assert.equal(parent.subagents[0]?.completionDelivery?.state, "disposed");
    const effects = yield* sql<{ readonly effect_type: string }>`
      SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id = ${stopCommandId}
    `;
    assert.include(
      effects.map((row) => row.effect_type),
      "delegated-tasks.stop",
    );

    // What the delegated-tasks.stop effect runs once the Stop commits.
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    assert.deepEqual(yield* threadState(childThreadId), {
      runs: ["interrupted", "queued:held"],
      watched: [],
    });
    assert.deepEqual((yield* threadState(grandchildThreadId)).runs, ["interrupted"]);

    // A retried effect stops nothing twice.
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted", "queued:held"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "thread.stop ends an idle thread's watches and accepts a thread with nothing to stop",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:stop-idle");
      yield* createWatchingThread(threadId, 3);

      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle"),
        threadId,
      });
      assert.deepEqual(yield* threadState(threadId), { runs: [], watched: [] });

      const again = yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle-again"),
        threadId,
      });
      assert.lengthOf(again.storedEvents, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a run Stop reached cannot delegate or start a watch, even after it ends", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-barrier");
    yield* createWatchingThread(threadId, 4);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = { ...(yield* orchestrator.getThreadProjection(threadId)).runs[0]!, startedAt: now };
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running" },
    });
    // A queued message the user cancelled does not count as the latest run.
    yield* send(threadId, "queued", "queue_after_active");
    const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-queued"),
      threadId,
      runId: queued.id,
    });
    // Stop reached the run, but its provider has not stopped it yet.
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupt-request"),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:stop-barrier:interrupt-request"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId: run.providerThreadId!,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1_000,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stop",
      },
    });

    assert.isTrue(Exit.isFailure(yield* Effect.exit(delegate(threadId, "late task"))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));

    // A slow watch_pull_request call can land after the stopped run ended.
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupted"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "interrupted", completedAt: now },
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));
    assert.deepEqual(yield* threadState(threadId), {
      runs: ["interrupted", "cancelled"],
      watched: [4],
    });

    // The user can still stop and restart a watch by hand.
    for (const watching of [false, true]) {
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`manual-watch:${watching}`),
        threadId,
        ...pullRequest(4),
        watching,
      });
    }
    assert.deepEqual((yield* threadState(threadId)).watched, [4]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop keeps a restart continuation of the stopped run from starting", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:stop-restart");
    yield* createWatchingThread(threadId, 8);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    // A server restart cut the run before its provider started; its continuation is pending.
    yield* projections.apply({
      id: EventId.make("event:stop-restart:cancelled"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "cancelled", startedAt: null, completedAt: now },
    });
    const at = DateTime.formatIso(now);
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (
        ${`effect:restart-continuation:${run.id}`}, 'command:restart', ${threadId},
        'provider-runtime.continue',
        ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: run.id })},
        'pending', 0, ${at}, ${at}, ${at}
      )
    `;

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-restart"),
      threadId,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("restart-continuation"),
      threadId,
      messageId: MessageId.make("message:restart-continuation"),
      text: "Continue.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: run.id,
    });
    assert.deepEqual(yield* threadState(threadId), { runs: ["cancelled"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "a successful %s blocks a newer restart continuation when completion timestamps tie",
  (stopType) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:stop-resumed-queue");
      yield* createWatchingThread(threadId, 12);
      yield* send(threadId, "first", "start_immediately");
      yield* send(threadId, "queued", "queue_after_active");
      const now = yield* DateTime.now;
      const [first, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(first);
      assert.isDefined(queued);
      for (const run of [first!, queued!]) {
        yield* projections.apply({
          id: EventId.make(`event:stop-resumed-queue:hold:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload:
            run.id === first!.id
              ? { ...run, status: "completed", completedAt: now }
              : { ...run, queueHeld: true },
        });
      }
      // A later turn runs ahead of the held queue, then recovery cancels it.
      yield* send(threadId, "restart source", "start_immediately");
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      yield* projections.apply({
        id: EventId.make("event:stop-resumed-queue:restart-cancelled"),
        type: "run.updated",
        threadId,
        runId: source.id,
        occurredAt: now,
        payload: { ...source, status: "cancelled", startedAt: now, completedAt: now },
      });
      const at = DateTime.formatIso(now);
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ${`effect:restart-continuation:${source.id}`}, 'command:restart', ${threadId},
          'provider-runtime.continue',
          ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: source.id })},
          'pending', 0, ${at}, ${at}, ${at}
        )
      `;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-older-queue"),
        threadId,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === queued!.id,
        )?.status,
        "starting",
      );
      yield* orchestrator.dispatch(
        stopType === "thread.stop"
          ? { type: "thread.stop", commandId: CommandId.make("stop-resumed-queue"), threadId }
          : {
              type: "run.interrupt",
              commandId: CommandId.make("stop-resumed-queue"),
              threadId,
              runId: queued!.id,
              holdQueue: true,
            },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      const interrupted = stopped.runs.find((run) => run.id === queued!.id)!;
      assert.equal(interrupted.status, "interrupted");
      assert.equal(DateTime.toEpochMillis(interrupted.completedAt!), DateTime.toEpochMillis(now));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("restart-after-stop"),
        threadId,
        messageId: MessageId.make("message:restart-after-stop"),
        text: "Continue.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: source.id,
      });
      assert.deepEqual(yield* threadState(threadId), {
        runs: ["completed", "interrupted", "cancelled"],
        watched: [],
      });
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect("resuming a held queue from a chosen message sends it before the rest", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:resume-chosen");
    yield* createWatchingThread(threadId, 13);
    yield* send(threadId, "first", "start_immediately");
    for (const text of ["a", "b", "c"]) yield* send(threadId, text, "queue_after_active");
    const now = yield* DateTime.now;
    const [first, ...queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
    for (const run of [first!, ...queued]) {
      yield* projections.apply({
        id: EventId.make(`event:resume-chosen:hold:${run.id}`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload:
          run.id === first!.id
            ? { ...run, status: "completed", completedAt: now }
            : { ...run, queueHeld: true },
      });
    }
    const [a, b, c] = queued;
    const refused = yield* Effect.exit(
      orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-from-finished"),
        threadId,
        runId: first!.id,
      }),
    );
    assert.isTrue(Exit.isFailure(refused));
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("resume-from-b"),
      threadId,
      runId: b!.id,
    });
    const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
    const read = (id: typeof a) => runs.find((run) => run.id === id!.id)!;
    assert.equal(read(b).status, "starting");
    assert.deepEqual(
      [a, c].map((run) => [read(run).status, read(run).queueHeld]),
      [
        ["queued", false],
        ["queued", false],
      ],
    );
    assert.isTrue(read(a).queuePosition! < read(c).queuePosition!);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a delegated task that cannot be stopped fails the walk after its siblings stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:stop-partial");
    yield* createWatchingThread(parentThreadId, 6);
    yield* send(parentThreadId, "work", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "stoppable task");
    const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
    // A task whose thread is gone, listed before the one that can stop.
    yield* projections.apply({
      id: EventId.make("event:stop-partial:missing-task"),
      type: "subagent.updated",
      threadId: parentThreadId,
      runId: task.runId!,
      nodeId: NodeId.make("node:stop-partial:missing"),
      providerInstanceId: instanceId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...task,
        id: NodeId.make("node:stop-partial:missing"),
        childThreadId: ThreadId.make("thread:stop-partial:missing"),
        startedAt: DateTime.subtract(task.startedAt!, { hours: 1 }),
      },
    });

    const walked = yield* Effect.exit(
      threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("stop-partial"),
      }),
    );
    assert.isTrue(Exit.isFailure(walked));
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop on a finished thread refuses a late agent watch", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-finished");
    yield* createWatchingThread(threadId, 9);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-finished:completed"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", startedAt: now, completedAt: now },
    });

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-finished"),
      threadId,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 10))));
    assert.deepEqual(yield* threadState(threadId), { runs: ["completed"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop marks a turn it cannot interrupt so a late agent watch is refused", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-lost-session");
    yield* createWatchingThread(threadId, 11);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    // The turn is running, but its provider session is gone, so the interrupt fails.
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:turn"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("provider-turn:stop-lost-session"),
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId!,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-lost-session"),
      threadId,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 12))));
    assert.deepEqual(yield* threadState(threadId), { runs: ["running"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a native child stop persists only its targeted effect and leaves its owner's queue and watch alone",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:native-child-stop");
      yield* createWatchingThread(threadId, 20);
      yield* send(threadId, "owner", "start_immediately");
      yield* delegate(threadId, "native-child-fixture");
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const now = yield* DateTime.now;
      const subagent = {
        ...before.subagents[0]!,
        origin: "provider_native" as const,
        driver: CLAUDE_PROVIDER,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        nativeTaskRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: "claude-task",
          strength: "strong" as const,
        },
        status: "running" as const,
        startedAt: now,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:agent"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: now,
        payload: subagent,
      });
      const providerThread = before.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...providerThread,
          driver: CLAUDE_PROVIDER,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          providerSessionId: ProviderSessionId.make("session:native-child-stop"),
        },
      });
      const providerTurnId = ProviderTurnId.make("turn:native-child-stop");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId: providerThread.id,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId!,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      // The owner has finished but its child and queued prompt remain.
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:owner-completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", startedAt: now, completedAt: now },
      });
      yield* send(threadId, "queued", "queue_after_active");
      const stateBefore = yield* threadState(threadId);
      const commandId = CommandId.make("stop-native-child");
      yield* orchestrator.dispatch({
        type: "subagent.stop",
        commandId,
        threadId,
        runId: run.id,
        subagentId: subagent.id,
      });
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      const effects = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id = ${commandId}
    `;
      assert.equal(effects.length, 1);
      assert.deepEqual(JSON.parse(effects[0]!.payload_json), {
        type: "provider-turn.interrupt",
        providerSessionId: "session:native-child-stop",
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, nativeTaskId: "claude-task" },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents[0]?.status,
        "running",
      );
      const unrelated = yield* Effect.exit(
        orchestrator.dispatch({
          type: "subagent.stop",
          commandId: CommandId.make("stop-unknown-child"),
          threadId,
          runId: run.id,
          subagentId: NodeId.make("unknown-child"),
        }),
      );
      assert.isTrue(Exit.isFailure(unrelated));
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "stops explicit roster ids idempotently without touching the Run, watches or subagents",
  () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:background-stop");
      yield* createWatchingThread(threadId, 31);
      yield* watch(threadId, 32);
      yield* send(threadId, "foreground", "start_immediately");
      yield* delegate(threadId, "keeps-working");
      const before = yield* orchestrator.getThreadProjection(threadId);
      const owner = before.providerThreads[0]!;
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:background-stop:roster"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...owner,
          providerSessionId: ProviderSessionId.make("session:background-stop"),
          pendingBackgroundTasks: [
            {
              taskId: "shell",
              kind: "command",
              startedAt: now,
              turnItemId: TurnItemId.make("launch"),
            },
            { taskId: "monitor", kind: "monitor" },
            { taskId: "opaque", kind: "background_task" },
            { taskId: "native-child", kind: "subagent" },
          ],
        },
      });
      const previousProviderId = ProviderThreadId.make("provider-thread:previous-background");
      yield* projections.apply({
        id: EventId.make("event:background-stop:previous-roster"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...owner,
          id: previousProviderId,
          providerSessionId: ProviderSessionId.make("session:previous-background"),
          pendingBackgroundTasks: [{ taskId: "previous-shell", kind: "command" }],
        },
      });
      const savedRoster = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${owner.id}`;
      assert.equal(
        JSON.parse(savedRoster[0]!.payload_json).pendingBackgroundTasks[0].startedAt,
        DateTime.formatIso(now),
      );
      const one = {
        threadId,
        commandId: CommandId.make("command:background-one"),
        taskIds: ["shell"],
      };
      assert.deepEqual(yield* threads.stopBackgroundWork(one), { stopping: ["shell"] });
      const oneEffects = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id = ${one.commandId}`;
      assert.equal(oneEffects.length, 1);
      assert.deepEqual(JSON.parse(oneEffects[0]!.payload_json), {
        type: "provider-task.stop",
        providerThreadId: owner.id,
        providerSessionId: "session:background-stop",
        taskId: "shell",
        kind: "command",
        turnItemIds: [],
      });
      yield* threads.dispatch({
        type: "background-task.settle",
        commandId: CommandId.make("command:background-one-settled"),
        threadId,
        providerThreadId: owner.id,
        taskId: "shell",
        turnItemIds: [],
      });
      assert.deepEqual(yield* threads.stopBackgroundWork(one), { stopping: ["shell"] });
      assert.equal(
        (yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE command_id = ${one.commandId}`)
          .length,
        1,
      );
      assert.deepEqual(
        yield* threads.stopBackgroundWork({
          threadId,
          commandId: CommandId.make("command:background-gone"),
          taskIds: ["gone"],
        }),
        { stopping: [] },
      );
      // Some provider tasks, such as Monitors, have no corresponding turn item.
      assert.deepEqual(
        yield* threads.stopBackgroundWork({
          threadId,
          commandId: CommandId.make("command:background-without-run"),
          taskIds: ["monitor"],
          runId: before.runs[0]!.id,
        }),
        { stopping: ["monitor"] },
      );
      const allCommandId = CommandId.make("command:background-all");
      const shown = (yield* readRootActivity({ rootThreadIds: [threadId] })).items[0]!
        .backgroundTasks;
      assert.deepEqual(
        shown.map((task) => task.taskId),
        ["monitor", "opaque", "previous-shell"],
      );
      const all = yield* threads.stopBackgroundWork({
        threadId,
        commandId: allCommandId,
        taskIds: [
          ...shown.map((task) => task.taskId),
          "native-child",
          "gone",
          "pull-request-watch:github.com/acme/widgets#31",
        ],
      });
      assert.deepEqual([...all.stopping].sort(), ["monitor", "opaque", "previous-shell"]);
      const allEffects = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id = ${allCommandId}`;
      assert.deepEqual(
        allEffects
          .map((row) => String(JSON.parse(row.payload_json).taskId))
          .toSorted((left, right) => left.localeCompare(right)),
        ["monitor", "opaque", "previous-shell"],
      );
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(after.runs, before.runs);
      assert.deepEqual(after.subagents, before.subagents);
      assert.deepEqual(after.thread.pullRequests, before.thread.pullRequests);
      assert.isTrue(
        after.providerThreads
          .find((thread) => thread.id === owner.id)!
          .pendingBackgroundTasks!.some((task) => task.taskId === "native-child"),
      );
      assert.deepEqual(
        yield* threads.stopBackgroundWork({
          threadId,
          commandId: CommandId.make("command:background-native-child"),
          taskIds: ["native-child"],
        }),
        { stopping: [] },
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("internal task settlement rejects a child-owned provider thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:settle-ownership");
    yield* createWatchingThread(threadId, 41);
    yield* send(threadId, "parent", "start_immediately");
    const childThreadId = yield* delegate(threadId, "child-owner");
    const parent = yield* orchestrator.getThreadProjection(threadId);
    const now = yield* DateTime.now;
    const owner = {
      ...parent.providerThreads[0]!,
      id: ProviderThreadId.make("provider-thread:child-owned"),
      appThreadId: childThreadId,
      ownerNodeId: parent.runs[0]!.rootNodeId!,
      pendingBackgroundTasks: [{ taskId: "child-shell", kind: "command" as const }],
    };
    yield* projections.apply({
      id: EventId.make("event:child-owned-roster"),
      type: "provider-thread.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: owner,
    });
    const result = yield* orchestrator
      .dispatch({
        type: "background-task.settle",
        commandId: CommandId.make("command:wrong-owner-settle"),
        threadId,
        providerThreadId: owner.id,
        taskId: "child-shell",
        turnItemIds: [],
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.deepEqual(
      (yield* projections.getThreadRecords(childThreadId, [
        "providerThreads",
      ])).providerThreads.find((thread) => thread.id === owner.id)?.pendingBackgroundTasks,
      owner.pendingBackgroundTasks,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "pause keeps delegated results and queued descendants without disposing their cohort",
  () =>
    Effect.gen(function* () {
      const pause = yield* SessionPause.make;
      const writer = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const root = ThreadId.make("thread:pause-parent");
      yield* createWatchingThread(root, 31);
      yield* send(root, "parent", "start_immediately");
      const child = yield* delegate(root, "retained child result");
      yield* send(child, "queued child follow-up", "queue_after_active");
      const before = yield* writer.getThreadProjection(root);
      const task = before.subagents[0]!;
      yield* store.apply({
        id: EventId.make("event:pause-retained-result"),
        type: "subagent.updated",
        threadId: root,
        occurredAt: yield* DateTime.now,
        payload: {
          ...task,
          status: "completed",
          result: "Retained evidence",
          completedAt: yield* DateTime.now,
          updatedAt: yield* DateTime.now,
        },
      });
      yield* pause.pause({ threadId: root, revision: "hold:delegated" });
      const after = yield* writer.getThreadProjection(root);
      assert.equal(after.subagents[0]?.status, "completed");
      assert.notEqual(after.subagents[0]?.completionDelivery?.state, "disposed");
      assert.deepEqual(after.subagents[0]?.result, "Retained evidence");
      assert.isTrue(yield* store.isExecutionPaused(child));
      const childState = yield* writer.getThreadProjection(child);
      assert.isTrue(childState.messages.some((m) => m.text === "queued child follow-up"));
      assert.isFalse(childState.runs.some((r) => r.queueHeld === true));
      assert.deepEqual((yield* threadState(root)).watched, [31]);
    }).pipe(Effect.provide(layerTest)),
);
