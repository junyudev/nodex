import { assert, it } from "@effect/vitest";
import {
  CommandId,
  CheckpointId,
  CheckpointScopeId,
  MessageId,
  EventId,
  NodeId,
  PlanId,
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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { decodeCodexAsyncQuestionReplies } from "../nodex/CodexConventions.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("replays stable command identities without creating another message or Run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:stable-submission");
    const create = {
      type: "thread.create" as const,
      commandId: CommandId.make("create:stable-submission"),
      threadId,
      projectId: ProjectId.make("project:stable-submission"),
      title: "Stable command",
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const created = yield* orchestrator.dispatch(create);
    assert.deepEqual(yield* orchestrator.dispatch(create), created);
    const message = {
      type: "message.dispatch" as const,
      commandId: CommandId.make("message-command:stable-submission"),
      threadId,
      messageId: MessageId.make("message:stable-submission"),
      text: "Inspect files",
      attachments: [],
      dispatchMode: { type: "start_immediately" as const },
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const accepted = yield* orchestrator.dispatch(message);
    const acceptedEffects = yield* outbox.listByCommandId(message.commandId);
    assert.isNotEmpty(acceptedEffects);
    for (let retry = 0; retry < 3; retry++)
      assert.deepEqual(yield* orchestrator.dispatch(message), accepted);
    assert.deepEqual(
      yield* orchestrator.dispatch({
        ...message,
        text: "A changed retry cannot replace accepted work",
        messageId: MessageId.make("message:changed-retry"),
      }),
      accepted,
    );
    assert.deepEqual(yield* outbox.listByCommandId(message.commandId), acceptedEffects);
    const projection = yield* orchestrator.getThreadRecords(threadId, ["messages", "runs"]);
    assert.equal(projection.messages.length, 1);
    assert.equal(projection.messages[0]?.text, message.text);
    assert.equal(projection.runs.length, 1);
    const otherThreadId = ThreadId.make("thread:other");
    yield* orchestrator.dispatch({
      ...create,
      threadId: otherThreadId,
      commandId: CommandId.make("create:other-thread"),
    });
    const unrelated = yield* orchestrator
      .dispatch({ ...message, threadId: otherThreadId })
      .pipe(Effect.result);
    assert.equal(unrelated._tag, "Failure");
    if (unrelated._tag === "Failure")
      assert.equal(unrelated.failure._tag, "OrchestratorCommandIdConflictError");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "dispatches metadata, queue resume and request controls without hydrating unrelated history",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:control-dispatch");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-control"),
        threadId,
        projectId: ProjectId.make("project:control-dispatch"),
        title: "Before",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const enabled of [false, true]) {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`auto-settle-${enabled}`),
          threadId,
          enabled,
        });
        const updated = yield* projections.getThreadProjection(threadId);
        assert.equal(updated.thread.autoSettleDisabledAt == null, enabled);
        const shell = yield* projections.getThreadShell(threadId);
        assert.ok(shell);
        assert.equal(shell.autoSettleDisabledAt == null, enabled);
      }
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete', ${threadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      assert.equal((yield* Effect.exit(projections.getThreadProjection(threadId)))._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-empty-queue"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-control"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("model-control"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
      const sessionId = ProviderSessionId.make("session:control-dispatch");
      yield* projections.apply({
        id: EventId.make("attach-control"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const mode of ["live", "message", "reply"] as const) {
        const requestId = RuntimeRequestId.make(`request:${mode}`);
        yield* projections.apply({
          id: EventId.make(`request:${mode}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make(`node:${mode}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability:
              mode === "live"
                ? { type: "live", providerSessionId: sessionId }
                : mode === "reply"
                  ? { type: "message", replyFormat: "codex_question_reply" }
                  : { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const nodeId = NodeId.make(`node:${mode}`);
        yield* projections.apply({
          id: EventId.make(`node:${mode}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`item:${mode}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${mode}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: mode === "live" ? 1 : mode === "message" ? 2 : 3,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [
              {
                id: "workspace",
                header: "Workspace",
                question: "Which working directory should the task use?",
                options: [],
                allowCustomAnswer: true,
              },
            ],
          },
        });
        yield* orchestrator.dispatch(
          mode !== "message"
            ? {
                type: "runtime-request.respond",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
                answers: { workspace: "/repo/target" },
              }
            : {
                type: "thread.user-input.dismiss",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
              },
        );
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.status,
          "resolved",
        );
        const response = yield* projections.getRuntimeResponseContext(threadId, requestId);
        assert.equal(response.node?.status, mode === "message" ? "cancelled" : "completed");
        assert.equal(response.item?.status, mode === "message" ? "cancelled" : "completed");
        if (mode === "reply") {
          // Codex reads replies to its own questions from its reply envelope.
          const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
            turnItemTypes: ["user_message"],
          });
          const reply = turnItems.find(
            (item) =>
              item.type === "user_message" &&
              item.messageId === `async-answer:${requestId}:respond:${mode}`,
          );
          assert.deepEqual(
            reply?.type === "user_message" ? decodeCodexAsyncQuestionReplies(reply.text) : null,
            [
              {
                questionItemId: "workspace",
                question: "Which working directory should the task use?",
                answer: "/repo/target",
              },
            ],
          );
        }
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("workspace-control"),
        threadId,
        worktreePath: "/new-repo",
      });
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.title, "After");
      assert.equal(thread.modelSelection.model, "gpt-6");
      assert.equal(thread.runtimeMode, "full-access");
      assert.deepEqual(
        (yield* projections.getThreadProviderContext(threadId)).providerSessions,
        [],
      );
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          type, status, ordinal, updated_at, payload_json)
        VALUES ('obsolete-output', ${threadId}, NULL, NULL, NULL, NULL,
          'command_execution', 'completed', 900, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES ('obsolete-plan', ${threadId}, NULL, 'old-node', 'proposed', 'completed', '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_handoffs
        (context_handoff_id, thread_id, target_run_id, to_provider_thread_id, strategy, status, updated_at, payload_json)
        VALUES ('obsolete-handoff', ${threadId}, 'old-run', 'old-provider-thread', 'full_thread_summary', 'ready', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-with-old-history"),
        threadId,
        messageId: MessageId.make("fresh-input"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const fresh = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message"],
      });
      assert.isAbove(fresh.turnItems.at(-1)!.ordinal, 900);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-with-old-history"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-with-old-history"),
        threadId,
      });
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "implements an active proposed plan from another Project while retaining both content owners",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:implement-plan");
      const planId = PlanId.make("plan:implement-plan");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-implement-plan"),
        threadId,
        projectId: ProjectId.make("project:implement-plan"),
        title: "Plan",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* projections.apply({
        id: EventId.make("plan:implement-plan"),
        type: "plan.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: planId,
          threadId,
          runId: null,
          nodeId: NodeId.make("node:implement-plan"),
          kind: "proposed_plan",
          status: "active",
          markdown: "# Plan\n\n1. Do the thing.",
        },
      });

      const targetThreadId = ThreadId.make("thread:implement-other-project-plan");
      const targetProjectId = ProjectId.make("project:plan-implementation-target");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:plan-implementation-target"),
        threadId: targetThreadId,
        projectId: targetProjectId,
        title: "Implementation",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("implement-plan"),
        threadId: targetThreadId,
        messageId: MessageId.make("implement-plan-input"),
        text: "Implement the plan.",
        attachments: [],
        sourcePlanRef: { threadId, planId },
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });

      assert.equal((yield* projections.getPlan(threadId, planId))?.status, "completed");
      const target = yield* projections.getThreadRecords(targetThreadId, ["runs", "messages"]);
      assert.equal(target.thread.projectId, targetProjectId);
      assert.equal(target.runs[0]?.threadId, targetThreadId);
      assert.deepEqual(target.runs[0]?.sourcePlanRef, { threadId, planId });
      assert.equal(
        (yield* projections.getThread(threadId)).projectId,
        ProjectId.make("project:implement-plan"),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "records a created Session in another Project and still rejects a foreign Run identity",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make("thread:created-parent-project");
      const targetThreadId = ThreadId.make("thread:created-other-project");
      for (const [threadId, projectId] of [
        [parentThreadId, ProjectId.make("project:created-parent")],
        [targetThreadId, ProjectId.make("project:created-target")],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId,
          title: threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`message:${threadId}`),
          threadId,
          messageId: MessageId.make(`message:${threadId}`),
          text: "Begin.",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const parentRun = (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs[0]!;
      const targetRun = (yield* projections.getThreadRecords(targetThreadId, ["runs"])).runs[0]!;
      yield* orchestrator.dispatch({
        type: "thread.created.record",
        commandId: CommandId.make("record:other-project"),
        parentThreadId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        targetThreadId,
        targetRunId: targetRun.id,
      });
      const recorded = (yield* projections.getThreadRecords(parentThreadId, ["turnItems"], {
        turnItemTypes: ["thread_created"],
      })).turnItems[0]!;
      assert.equal(recorded.type, "thread_created");
      if (recorded.type !== "thread_created") return;
      assert.equal(recorded.runId, parentRun.id);
      assert.equal(recorded.targetThreadId, targetThreadId);
      assert.equal(recorded.targetRunId, targetRun.id);
      const wrongTarget = yield* Effect.result(
        orchestrator.dispatch({
          type: "thread.created.record",
          commandId: CommandId.make("record:foreign-run"),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          targetThreadId,
          targetRunId: parentRun.id,
        }),
      );
      assert.equal(wrongTarget._tag, "Failure");
      if (wrongTarget._tag === "Failure")
        assert.instanceOf(wrongTarget.failure, Orchestrator.OrchestratorDispatchError);
      assert.lengthOf(
        (yield* projections.getThreadRecords(parentThreadId, ["turnItems"], {
          turnItemTypes: ["thread_created"],
        })).turnItems,
        1,
      );
    }).pipe(Effect.provide(layerTest)),
);

// Stop's settle follow-up runs after the provider interrupt returns, possibly
// long after the Stop (retries) or again (an effect replayed after a crash).
// A later run's background work is not that Stop's to end.
it.effect("settles only the stopped run's background work, once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:settle-binding");
    const providerThreadId = ProviderThreadId.make("provider-thread:settle-binding");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-binding"),
      threadId,
      projectId: ProjectId.make("project:settle-binding"),
      title: "Settle binding",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("settle-binding:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const commandItem = (ordinal: number) => TurnItemId.make(`turn-item:settle-binding:${ordinal}`);
    for (const ordinal of [1, 2]) {
      const runId = RunId.make(`run:settle-binding:${ordinal}`);
      const attemptId = RunAttemptId.make(`attempt:settle-binding:${ordinal}`);
      const nodeId = NodeId.make(`node:settle-binding:${ordinal}`);
      const providerTurnId = ProviderTurnId.make(`provider-turn:settle-binding:${ordinal}`);
      yield* projections.apply({
        id: EventId.make(`settle-binding:run:${ordinal}`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:settle-binding:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:attempt:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:turn:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: commandItem(ordinal),
          threadId,
          runId,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 10,
          status: "running",
          title: `Background command ${ordinal}`,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: `sleep ${ordinal}`,
        },
      });
    }
    const itemStatuses = Effect.map(projections.getThreadProjection(threadId), (projection) =>
      projection.turnItems
        .flatMap((item) => (item.type === "command_execution" ? [`${item.id}:${item.status}`] : []))
        .toSorted(),
    );
    // The settle that followed a Stop of run 1's turn, dispatched only after
    // run 2 had settled with work of its own.
    const settle = {
      type: "thread.background-work.settle",
      commandId: CommandId.make("stop-run-1:background-work-settled"),
      threadId,
      providerThreadId,
      providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
    } as const;
    yield* orchestrator.dispatch(settle);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
    ]);

    // A settle that found nothing to end replays as a no-op, even after work
    // it would match appears: its receipt is recorded with no events.
    const emptySettle = {
      ...settle,
      commandId: CommandId.make("stop-run-1-again:background-work-settled"),
    };
    const first = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(first.storedEvents, 0);
    yield* projections.apply({
      id: EventId.make("settle-binding:item:late"),
      type: "turn-item.updated",
      threadId,
      runId: RunId.make("run:settle-binding:1"),
      occurredAt: now,
      payload: {
        id: commandItem(3),
        threadId,
        runId: RunId.make("run:settle-binding:1"),
        nodeId: NodeId.make("node:settle-binding:1"),
        providerThreadId,
        providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 30,
        status: "running",
        title: "Late background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 3",
      },
    });
    const replayed = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(replayed.storedEvents, 0);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
      `${commandItem(3)}:running`,
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps delegated child pull-request links independent of the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:parent-pr");
    const projectId = ProjectId.make("project:parent-pr");
    const parentPullRequest = {
      projectId,
      repository: "pingdotgg/t3code",
      number: 123,
      url: "https://github.com/pingdotgg/t3code/pull/123",
    };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent-pr"),
      threadId: parentThreadId,
      projectId,
      title: "Parent with a linked PR",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/parent-pr",
      worktreePath: "/repo-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-parent-pr"),
      threadId: parentThreadId,
      linkedPullRequest: parentPullRequest,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-parent-pr"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:parent-pr"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-parent-pr"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Review the changes",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const updatedParent = yield* projections.getThreadProjection(parentThreadId);
    const childThreadId = updatedParent.subagents[0]!.childThreadId!;
    const child = yield* projections.getThreadProjection(childThreadId);
    assert.isNull(child.thread.linkedPullRequest);
    assert.deepEqual(child.thread.pullRequests, []);
    assert.equal(child.thread.branch, parent.thread.branch);
    assert.equal(child.thread.worktreePath, parent.thread.worktreePath);
    assert.equal(child.thread.lineage.parentThreadId, parentThreadId);

    const childPullRequest = {
      ...parentPullRequest,
      number: 456,
      url: "https://github.com/pingdotgg/t3code/pull/456",
    };
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-child-pr"),
      threadId: childThreadId,
      linkedPullRequest: childPullRequest,
    });
    const linkedChild = yield* projections.getThreadProjection(childThreadId);
    assert.deepEqual(linkedChild.thread.linkedPullRequest, childPullRequest);
    assert.deepEqual(
      linkedChild.thread.pullRequests?.map((link) => link.number),
      [456],
    );
    const parentAfterChildLink = yield* projections.getThreadProjection(parentThreadId);
    assert.deepEqual(parentAfterChildLink.thread.linkedPullRequest, parentPullRequest);
    assert.deepEqual(parentAfterChildLink.thread.pullRequests, parent.thread.pullRequests);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "idle Project detaches reject a concurrently admitted Run and preserve its session binding",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:idle-detach");
      const projectId = ProjectId.make("project:idle-detach");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:idle-detach"),
        threadId,
        projectId,
        title: "Idle",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const providerSessionId = ProviderSessionId.make("native:idle-detach");
      yield* store.apply({
        type: "provider-session.attached",
        id: EventId.make("attach:idle-detach"),
        threadId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/workspace",
          model: "model",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start:idle-detach"),
        threadId,
        messageId: MessageId.make("message:idle-detach"),
        text: "Work",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const detach = {
        type: "provider-session.detach" as const,
        commandId: CommandId.make("close:busy-detach"),
        threadId,
        providerSessionId,
        onlyIfIdle: true,
        revokeMcpCredential: true,
      };
      assert.equal((yield* orchestrator.dispatch(detach).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* store.getProjectProviderSessionBindings(projectId)).items.length, 1);
      const run = (yield* store.getThreadRecords(threadId, ["runs"])).runs[0]!;
      yield* store.apply({
        type: "run.updated",
        id: EventId.make("complete:idle-detach"),
        threadId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      yield* orchestrator.dispatch({ ...detach, commandId: CommandId.make("close:idle-detach") });
      assert.equal((yield* store.getProjectProviderSessionBindings(projectId)).items.length, 0);
      assert.equal((yield* store.getThread(threadId)).deletedAt, null);
      const effects = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_effect_outbox WHERE effect_type='provider-session.detach'`;
      assert.equal(effects.length, 1);
      assert.equal(JSON.parse(effects[0]!.payload_json).revokeMcpCredential, true);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "fences message-edit rewinds against foreign Runs and unsettled conversations before native work",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:edit-guard");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:edit-guard"),
        threadId,
        projectId: ProjectId.make("project:edit-guard"),
        title: "Edit guard",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const ordinal of [1, 2])
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`dispatch:edit-guard:${ordinal}`),
          threadId,
          messageId: MessageId.make(`message:edit-guard:${ordinal}`),
          text: `Queued ${ordinal}`,
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      assert.equal(runs.length, 2);
      for (const runId of [RunId.make("run:foreign"), runs[0]!.id, runs[1]!.id]) {
        const error = yield* orchestrator
          .dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make(`rewind:edit-guard:${runId}`),
            threadId,
            beforeRunId: runId,
            scopeId: CheckpointScopeId.make("scope:edit-guard"),
            checkpointId: CheckpointId.make("checkpoint:edit-guard"),
            restoreFiles: false,
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorDispatchError");
        if (error._tag === "OrchestratorDispatchError")
          assert.equal(
            error.cause,
            "Only a sent user message of an idle conversation can be edited.",
          );
      }
      assert.deepEqual((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs, runs);
    }).pipe(Effect.provide(layerTest)),
);
