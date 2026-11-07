import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  PositiveInt,
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
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionReplay from "../orchestration-v2/testkit/ProjectionReplay.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRuntimeRecovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { seedUndecodableHistory } from "../orchestration-v2/testkit/HistoryPressure.ts";
import { consume } from "./ImportedExecution.ts";
import { IMPORT_CANCELLATION_REASON } from "./ImportedExecutionSettlement.ts";

const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId: providerInstanceId, model: "claude-sonnet-4-6" };
const driver = ProviderDriverKind.make("claudeAgent");
const threadId = ThreadId.make("thread:copied-work");
const providerThreadId = ProviderThreadId.make("native:copied-work");
const sessionId = ProviderSessionId.make("session:copied-work");
const turnId = ProviderTurnId.make("turn:copied-work");
const requestId = RuntimeRequestId.make("approval:copied-work");
const taskId = NodeId.make("task:copied-work");
const childId = ThreadId.make("thread:copied-child");
const marker = JSON.stringify({
  version: 1,
  sourceProfileHome: "/original/profile",
  importedAt: "2026-11-01T00:00:00Z",
});
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, EffectOutbox.layer);
const persistence = EventSink.layer.pipe(Layer.provideMerge(stores));

const seed = Effect.fnUntraced(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const events: Array<OrchestrationV2DomainEvent> = [];
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project:copied-work"),
    title: "Copied work",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/external/repository",
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
    createdBy: "user",
    creationSource: "web",
    limitRecovery: {
      runId: RunId.make("run:running"),
      resetAt: DateTime.formatIso(now),
      autoResume: true,
    },
    pullRequests: [
      {
        host: "github.com",
        repository: "example/repo",
        number: PositiveInt.make(1),
        url: "https://github.com/example/repo/pull/1",
        source: "manual",
        linkedAt: DateTime.formatIso(now),
        snapshot: null,
        stack: null,
        watch: {
          startedAt: DateTime.formatIso(now),
          headSha: null,
          failedChecks: [],
          passed: false,
          passedChecks: [],
          remarksThrough: DateTime.formatIso(now),
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        },
      },
    ],
  };
  events.push({
    id: EventId.make("fixture:thread"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  events.push({
    id: EventId.make("fixture:child"),
    type: "thread.created",
    threadId: childId,
    occurredAt: now,
    payload: {
      ...thread,
      id: childId,
      lineage: {
        parentThreadId: threadId,
        relationshipToParent: "subagent",
        rootThreadId: threadId,
      },
      forkedFrom: { type: "node", nodeId: taskId },
      creationSource: "mcp",
      createdBy: "agent",
    },
  });
  const statuses = ["running", "queued", "preparing", "starting", "waiting", "completed"] as const;
  for (const [index, status] of statuses.entries()) {
    const runId = RunId.make(`run:${status}`);
    const nodeId = NodeId.make(`node:${status}`);
    const attemptId = RunAttemptId.make(`attempt:${status}`);
    const run: OrchestrationV2Run = {
      id: runId,
      threadId,
      ordinal: PositiveInt.make(index + 1),
      providerInstanceId,
      modelSelection,
      providerThreadId,
      userMessageId: MessageId.make(`message:${status}`),
      rootNodeId: nodeId,
      activeAttemptId: attemptId,
      status,
      queuePosition: status === "queued" ? PositiveInt.make(1) : null,
      requestedAt: now,
      startedAt: status === "queued" ? null : now,
      completedAt: status === "completed" ? now : null,
      checkpointId: null,
      contextHandoffId: null,
      ...(status === "running"
        ? {
            recovery: {
              kind: "process_lost",
              failure: { class: "transport_error", message: "Lost", code: null, retryable: true },
              streakStartedAt: now,
              attempt: PositiveInt.make(1),
              maxAttempts: null,
              nextAttemptAt: now,
            },
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: PositiveInt.make(2),
              delivery: {
                generation: PositiveInt.make(1),
                messageId: MessageId.make("message:queued"),
                taskIds: [taskId],
              },
            },
          }
        : {}),
      // A completed compaction can still automatically retry a failed Run at startup.
      ...(status === "completed"
        ? {
            contextRecovery: {
              failedRunId: RunId.make("run:running"),
              providerThreadId,
              nativeThreadId: "native-original",
              phase: "compact",
            },
          }
        : {}),
    };
    if (status === "running")
      events.push({
        id: EventId.make("fixture:child-run"),
        type: "run.created",
        threadId: childId,
        occurredAt: now,
        payload: {
          ...run,
          id: RunId.make("run:child"),
          threadId: childId,
          userMessageId: MessageId.make("message:child"),
          rootNodeId: null,
          activeAttemptId: null,
          providerThreadId: null,
          delegatedTaskId: taskId,
        },
      });
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId,
      runId,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "root_turn",
      status: status === "completed" ? "completed" : "running",
      countsForRun: true,
      providerThreadId,
      providerTurnId: status === "running" ? turnId : null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
    };
    events.push(
      {
        id: EventId.make(`fixture:${status}:run`),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: run,
      },
      {
        id: EventId.make(`fixture:${status}:node`),
        type: "node.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: node,
      },
      {
        id: EventId.make(`fixture:${status}:attempt`),
        type: "run-attempt.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: PositiveInt.make(1),
          rootNodeId: nodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId: status === "running" ? turnId : null,
          reason: "initial",
          status: status === "completed" ? "completed" : "running",
          startedAt: now,
          completedAt: status === "completed" ? now : null,
        },
      },
      {
        id: EventId.make(`fixture:${status}:message`),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: run.userMessageId,
          threadId,
          runId,
          nodeId,
          role: status === "running" ? "assistant" : "user",
          text: `Retain ${status} text`,
          attachments: [],
          streaming: status === "running",
          createdAt: now,
          updatedAt: now,
          createdBy: "user",
          creationSource: "web",
        },
      },
    );
  }
  const baseItem = {
    threadId,
    runId: RunId.make("run:running"),
    nodeId: NodeId.make("node:running"),
    providerThreadId,
    providerTurnId: turnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running" as const,
    title: "Work in progress",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  const items: Array<OrchestrationV2TurnItem> = [
    {
      ...baseItem,
      id: TurnItemId.make("item:command"),
      type: "command_execution",
      input: "touch /external/repository/result",
      output: "retained output",
    },
    {
      ...baseItem,
      id: TurnItemId.make("item:secret"),
      type: "secret_request",
      label: "Key",
      reason: "Needed",
      secretStatus: "pending",
    },
  ];
  const task: OrchestrationV2Subagent = {
    id: taskId,
    threadId,
    runId: RunId.make("run:running"),
    parentNodeId: NodeId.make("node:running"),
    origin: "app_owned",
    createdBy: "agent",
    driver,
    providerInstanceId,
    providerThreadId,
    childThreadId: childId,
    nativeTaskRef: null,
    prompt: "Do delegated work",
    title: "Delegate",
    model: null,
    completionWake: "always",
    completionDelivery: { state: "claimed", observedByRunId: RunId.make("run:queued") },
    status: "running",
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  events.push(
    {
      id: EventId.make("fixture:session"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver,
        providerInstanceId,
        status: "ready",
        cwd: "/external/repository",
        model: null,
        capabilities: ClaudeProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    },
    {
      id: EventId.make("fixture:native-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: sessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-original", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: PositiveInt.make(1),
        lastRunOrdinal: PositiveInt.make(6),
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [
          {
            taskId: "background-command",
            kind: "command",
            description: "Background shell",
            startedAt: now,
          },
        ],
        contextUsage: null,
        goal: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      id: EventId.make("fixture:turn"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: turnId,
        providerThreadId,
        nodeId: NodeId.make("node:running"),
        runAttemptId: RunAttemptId.make("attempt:running"),
        nativeTurnRef: null,
        ordinal: PositiveInt.make(1),
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      id: EventId.make("fixture:approval"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId: NodeId.make("node:running"),
        providerTurnId: turnId,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: sessionId },
        createdAt: now,
        resolvedAt: null,
      },
    },
    {
      id: EventId.make("fixture:question"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("question"),
        nodeId: NodeId.make("node:running"),
        providerTurnId: turnId,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    },
    {
      id: EventId.make("fixture:task"),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: task,
    },
    {
      id: EventId.make("fixture:native-task"),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...task,
        id: NodeId.make("zz-native-task"),
        origin: "provider_native",
        result: "Retained native task output",
        nativeTaskRef: { driver, nativeId: "native-task", strength: "strong" },
        childThreadId: null,
        workflow: { phases: [], agents: [{ index: 0, label: "Worker", state: "running" }] },
      },
    },
    ...items.map((item): OrchestrationV2DomainEvent => ({
      id: EventId.make(`fixture:${item.id}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: item,
    })),
  );
  yield* sink.write({ events });
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  yield* outbox.enqueue([
    {
      id: "effect:start",
      commandId: CommandId.make("fixture"),
      threadId,
      request: { type: "provider-turn.start", runId: RunId.make("run:running") },
    },
    {
      id: "effect:recovery",
      commandId: CommandId.make("fixture"),
      threadId,
      request: {
        type: "run.recover",
        runId: RunId.make("run:running"),
        attemptOrdinal: PositiveInt.make(2),
      },
    },
    {
      id: "effect:continuation",
      commandId: CommandId.make("fixture"),
      threadId,
      request: { type: "provider-runtime.continue", sourceRunId: RunId.make("run:running") },
    },
    {
      id: "effect:checkpoint",
      commandId: CommandId.make("fixture"),
      threadId,
      request: { type: "preview.cleanup" },
    },
  ]);
  yield* outbox.claimNext({ workerId: "source-runtime", leaseDurationMs: 60_000 });
  yield* sql`INSERT INTO scheduled_tasks ${sql.insert({ task_id: "scheduled", title: "Automation", prompt: "Retained prompt", enabled: 1, schedule_json: '{"type":"interval","everyMs":1000}', project_id: "project", thread_id: threadId, workspace_strategy_json: '{"type":"root"}', model_selection_json: JSON.stringify(modelSelection), runtime_mode: "full-access", interaction_mode: "default", created_by: "user", creation_source: "web", created_at: DateTime.formatIso(now), updated_at: DateTime.formatIso(now), next_run_at: DateTime.formatIso(now), last_run_at: null, last_run_status: "never", last_run_error: null, run_count: 0 })}`;
  yield* sql`INSERT INTO orchestration_v2_thread_launch_workflows ${sql.insert({ command_id: "prepare", thread_id: threadId, project_id: "project", status: "preparing", title: "Preparation", worktree_path: "/external/repository", created_at: DateTime.formatIso(now), updated_at: DateTime.formatIso(now) })}`;
});

it.live(
  "atomically retires all copied execution before engine startup, without replaying effects or wakes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-import-settlement-" });
      const runtimeHome = `${home}/agent-runtime`;
      yield* fs.makeDirectory(runtimeHome);
      const markerPath = `${runtimeHome}/imported-execution.json`;
      const database = Sqlite.layerFromPath(`${runtimeHome}/agent-runtime.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      const layer = persistence.pipe(Layer.provideMerge(database));
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* seed();
          yield* fs.writeFileString(markerPath, marker);
          yield* consume(runtimeHome);
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const sql = yield* SqlClient.SqlClient;
          const sink = yield* EventSink.EventSinkV2;
          const settled = yield* projections.getThreadProjection(threadId);
          expect(settled.runs.map((run) => run.status)).toEqual([
            "cancelled",
            "cancelled",
            "cancelled",
            "cancelled",
            "cancelled",
            "completed",
          ]);
          expect(settled.runs.every((run) => run.recovery === undefined)).toBe(true);
          expect(settled.runs[0]?.delegatedCompletion).toMatchObject({
            disposition: "disposed",
            delivery: null,
          });
          expect(settled.runs.at(-1)?.contextRecovery?.phase).toBe("complete");
          expect(settled.attempts.filter((attempt) => attempt.status === "cancelled")).toHaveLength(
            5,
          );
          expect(settled.nodes.filter((node) => node.status === "cancelled")).toHaveLength(5);
          for (const records of [settled.providerTurns, settled.runtimeRequests, settled.subagents])
            expect(records.every((record) => record.status === "cancelled")).toBe(true);
          expect(
            settled.runtimeRequests.every(
              (request) => request.responseCapability.type === "not_resumable",
            ),
          ).toBe(true);
          expect(settled.subagents[0]?.completionDelivery?.state).toBe("disposed");
          expect(settled.subagents[1]?.workflow?.agents[0]).toMatchObject({
            state: "failed",
            result: IMPORT_CANCELLATION_REASON,
          });
          expect(settled.subagents[1]?.result).toBe("Retained native task output");
          expect(settled.messages.every((message) => !message.streaming)).toBe(true);
          expect(
            settled.turnItems
              .filter((item) => item.type === "run_interrupt_request")
              .map((item) => item.message),
          ).toEqual(Array(5).fill(IMPORT_CANCELLATION_REASON));
          expect(settled.turnItems.find((item) => item.type === "command_execution")).toMatchObject(
            { status: "cancelled", output: "retained output" },
          );
          expect(settled.turnItems.find((item) => item.type === "secret_request")).toMatchObject({
            status: "cancelled",
            secretStatus: "cancelled",
          });
          expect(settled.thread.worktreePath).toBe("/external/repository");
          expect(settled.thread.limitRecovery).toBeNull();
          expect(settled.thread.pullRequests?.[0]?.watch).toBeUndefined();
          expect((yield* projections.getThreadProjection(childId)).runs[0]?.status).toBe(
            "cancelled",
          );
          expect(settled.providerThreads[0]).toMatchObject({
            nativeThreadRef: null,
            pendingBackgroundTasks: [],
            status: "not_loaded",
          });
          expect(settled.providerSessions).toHaveLength(0);
          expect(yield* sql`SELECT enabled, next_run_at, prompt FROM scheduled_tasks`).toEqual([
            { enabled: 0, next_run_at: null, prompt: "Retained prompt" },
          ]);
          expect(
            yield* sql`SELECT status, last_error FROM orchestration_v2_thread_launch_workflows`,
          ).toEqual([{ status: "failed", last_error: IMPORT_CANCELLATION_REASON }]);
          const cancelledEffects = yield* sql<{
            status: string;
            last_error: string;
          }>`SELECT status, last_error FROM orchestration_v2_effect_outbox`;
          expect(cancelledEffects).toHaveLength(4);
          expect(
            cancelledEffects.every(
              (effect) =>
                effect.status === "cancelled" && effect.last_error === IMPORT_CANCELLATION_REASON,
            ),
          ).toBe(true);
          const sequence = yield* sink.latestSequence();
          // Simulate commit-before-marker-removal: new local state must survive the receipt retry.
          yield* sql`UPDATE scheduled_tasks SET enabled = 1 WHERE task_id = 'scheduled'`;
          yield* fs.writeFileString(markerPath, marker);
          yield* consume(runtimeHome);
          expect(yield* sink.latestSequence()).toBe(sequence);
          expect(yield* sql`SELECT enabled FROM scheduled_tasks`).toEqual([{ enabled: 1 }]);
          yield* sql`UPDATE scheduled_tasks SET enabled = 0 WHERE task_id = 'scheduled'`;
          expect(yield* fs.exists(markerPath)).toBe(false);
          const replay = ProjectionReplay.layer.pipe(Layer.provideMerge(layer));
          expect(
            (yield* ProjectionReplay.ProjectionReplay.use((owner) => owner.rebuild).pipe(
              Effect.provide(replay),
            )).valid,
          ).toBe(true);
          expect(yield* projections.getThreadProjection(threadId)).toEqual(settled);
        }).pipe(Effect.provide(layer)),
      );

      const lookup = vi.fn((instanceId: ProviderInstanceId) =>
        Effect.fail(new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId })),
      );
      const execute = vi.fn(() => Effect.void);
      const engine = ProviderReplayHarness.layerWithRegistry(
        { name: "copied-work-import" },
        Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          get: lookup,
          list: () => Effect.succeed([]),
        }),
        {
          databaseLayer: database,
          recoverOnStartup: true,
          continueThreadsAfterServerUpdate: true,
          runContinuationWorker: true,
          afterEffectExecution: execute,
        },
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.recoverContextRequests;
          yield* orchestrator.recoverDelegatedTasks;
          expect(yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain()).toBe(0);
          expect(Option.isNone(yield* (yield* EffectOutbox.EffectOutboxV2).nextClaimableAt)).toBe(
            true,
          );
          expect((yield* orchestrator.getThreadProjection(threadId)).runs).toHaveLength(6);
          expect(lookup).not.toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
        }).pipe(Effect.provide(engine)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "filters settled history in SQL instead of decoding historical projection or event bodies",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeHome = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-import-history-" });
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.formatIso(yield* DateTime.now);
      // An irrelevant historical event is deliberately undecodable as a domain event.
      // Import only scans its text for managed paths; it must never hydrate it.
      yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
        VALUES ('history:event','thread','history:events',1,'thread.metadata-updated',${now},'system','{"history":"unrelated text"}','{}')`;
      yield* seedUndecodableHistory({
        threadId: ThreadId.make("thread:settled-history"),
        count: 1_000,
        at: now,
      });
      // These settled tasks have no pending app-owned delivery.
      yield* sql`UPDATE orchestration_v2_projection_subagents SET origin = 'provider_native' WHERE subagent_id LIKE 'history:%'`;
      yield* fs.writeFileString(`${runtimeHome}/imported-execution.json`, marker);
      yield* consume(runtimeHome);
      expect(
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE status = 'completed'`,
      ).toEqual([{ count: 1_001 }]);
    }).pipe(
      Effect.provide(persistence.pipe(Layer.provideMerge(Sqlite.layerMemory))),
      Effect.provide(NodeServices.layer),
    ),
);

it.live(
  "does not promote queues or delegated wakes while import cancellation events reach live engine listeners",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeHome = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-import-reactors-" });
      const database = Sqlite.layerFromPath(`${runtimeHome}/agent-runtime.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.scoped(
        seed().pipe(Effect.provide(persistence.pipe(Layer.provideMerge(database)))),
      );
      yield* fs.writeFileString(`${runtimeHome}/imported-execution.json`, marker);
      const lookup = vi.fn((instanceId: ProviderInstanceId) =>
        Effect.fail(new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId })),
      );
      const engine = ProviderReplayHarness.layerWithRegistry(
        { name: "copied-work-live-listeners" },
        Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          get: lookup,
          list: () => Effect.succeed([]),
        }),
        { databaseLayer: database, runEffectWorker: false, runContinuationWorker: true },
      );
      const startup = ProviderRuntimeRecovery.layer.pipe(
        Layer.provideMerge(engine),
        Layer.provideMerge(database),
        Layer.provide(IdAllocator.layer),
        Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* consume(runtimeHome);
          const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
          yield* recovery.recover;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.recoverDelegatedTasks;
          yield* orchestrator.recoverContextRequests;
          yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          expect(yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain()).toBe(0);
          expect((yield* orchestrator.getThreadProjection(threadId)).runs).toHaveLength(6);
          expect((yield* orchestrator.getThreadProjection(childId)).runs[0]?.status).toBe(
            "cancelled",
          );
          expect(lookup).not.toHaveBeenCalled();
        }).pipe(Effect.provide(startup)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rolls all import changes back and retains the marker if settlement cannot finish", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runtimeHome = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-import-rollback-" });
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const sequence = yield* sink.latestSequence();
    const effectsBefore =
      yield* sql`SELECT effect_id, status, lease_owner FROM orchestration_v2_effect_outbox ORDER BY effect_id`;
    yield* sql`UPDATE orchestration_v2_projection_nodes SET payload_json = '{}' WHERE node_id = 'node:running'`;
    yield* fs.writeFileString(`${runtimeHome}/imported-execution.json`, marker);
    expect(yield* consume(runtimeHome).pipe(Effect.isFailure)).toBe(true);
    expect(yield* fs.exists(`${runtimeHome}/imported-execution.json`)).toBe(true);
    expect(yield* sink.latestSequence()).toBe(sequence);
    expect(
      yield* sql`SELECT status FROM orchestration_v2_projection_runs WHERE run_id = 'run:running'`,
    ).toEqual([{ status: "running" }]);
    expect(yield* sql`SELECT enabled FROM scheduled_tasks`).toEqual([{ enabled: 1 }]);
    expect(
      yield* sql`SELECT effect_id, status, lease_owner FROM orchestration_v2_effect_outbox ORDER BY effect_id`,
    ).toEqual(effectsBefore);
    expect(yield* sql`SELECT import_key FROM execution_store_imports`).toEqual([]);
  }).pipe(
    Effect.provide(persistence.pipe(Layer.provideMerge(Sqlite.layerMemory))),
    Effect.provide(NodeServices.layer),
  ),
);
