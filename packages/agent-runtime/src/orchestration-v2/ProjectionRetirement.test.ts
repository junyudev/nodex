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
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const sqlLayer = ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));

const retirementContract = (nativeCompletesFirst = false, completedParent = false) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const started = DateTime.makeUnsafe("2026-10-15T00:00:00.000Z");
    const retired = DateTime.makeUnsafe("2026-10-15T00:01:00.000Z");
    const threadId = ThreadId.make("thread:compact-retirement");
    const runId = RunId.make("run:retiring");
    const deliveryId = RunId.make("run:delivery");
    const queuedId = RunId.make("run:user-queued");
    const attemptId = RunAttemptId.make("attempt:retiring");
    const rootId = NodeId.make("node:retiring");
    const deliveryRootId = NodeId.make("node:delivery");
    const providerThreadId = ProviderThreadId.make("provider-thread:retiring");
    const providerTurnId = ProviderTurnId.make("provider-turn:retiring");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const driver = ProviderDriverKind.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
    const body = "retained native output ".repeat(4096);
    const run: OrchestrationV2Run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId,
      userMessageId: MessageId.make("message:input"),
      rootNodeId: rootId,
      activeAttemptId: attemptId,
      status: "running",
      requestedAt: started,
      startedAt: started,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
      delegatedCompletion: {
        disposition: "open",
        nextGeneration: 3,
        delivery: {
          generation: 2,
          messageId: MessageId.make("message:delivery"),
          taskIds: [NodeId.make("task:app")],
        },
      },
    };
    const node = {
      id: rootId,
      threadId,
      runId,
      parentNodeId: null,
      rootNodeId: rootId,
      kind: "root_turn" as const,
      status: "running" as const,
      countsForRun: true,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: started,
      completedAt: null,
    };
    const itemBase = {
      threadId,
      runId,
      nodeId: rootId,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running" as const,
      title: "Native work",
      startedAt: started,
      completedAt: null,
      updatedAt: started,
    };
    const taskBase = {
      threadId,
      runId,
      parentNodeId: rootId,
      createdBy: "agent" as const,
      driver,
      providerInstanceId,
      providerThreadId,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: body,
      title: "Task",
      model: null,
      status: "running" as const,
      result: body,
      startedAt: started,
      completedAt: null,
      updatedAt: started,
    };
    const events: OrchestrationV2DomainEvent[] = [
      {
        id: EventId.make("event:thread"),
        type: "thread.created",
        threadId,
        occurredAt: started,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:retirement"),
          title: "Retirement",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: started,
          updatedAt: started,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      },
      {
        id: EventId.make("event:run"),
        type: "run.created",
        threadId,
        occurredAt: started,
        payload: run,
      },
      {
        id: EventId.make("event:delivery"),
        type: "run.created",
        threadId,
        occurredAt: started,
        payload: {
          ...run,
          id: deliveryId,
          ordinal: 2,
          userMessageId: MessageId.make("message:delivery"),
          status: "queued",
          rootNodeId: deliveryRootId,
          activeAttemptId: null,
          queuePosition: 1,
          startedAt: null,
          delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null },
        },
      },
      {
        id: EventId.make("event:queued"),
        type: "run.created",
        threadId,
        occurredAt: started,
        payload: {
          ...run,
          id: queuedId,
          ordinal: 3,
          userMessageId: MessageId.make("message:queued"),
          status: "queued",
          rootNodeId: null,
          activeAttemptId: null,
          queueHeld: true,
          queuePosition: 2,
          startedAt: null,
        },
      },
      {
        id: EventId.make("event:node"),
        type: "node.updated",
        threadId,
        occurredAt: started,
        payload: node,
      },
      {
        id: EventId.make("event:delivery-node"),
        type: "node.updated",
        threadId,
        occurredAt: started,
        payload: {
          ...node,
          id: deliveryRootId,
          rootNodeId: deliveryRootId,
          runId: deliveryId,
          status: "pending",
        },
      },
      {
        id: EventId.make("event:attempt"),
        type: "run-attempt.created",
        threadId,
        occurredAt: started,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: rootId,
          providerInstanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "running",
          startedAt: started,
          completedAt: null,
        },
      },
      {
        id: EventId.make("event:turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: started,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: rootId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: started,
          completedAt: null,
          tokenUsage: { usedTokens: 123, updatedAt: "2026-10-15T00:00:00.000Z" },
        },
      },
      {
        id: EventId.make("event:command"),
        type: "turn-item.updated",
        threadId,
        occurredAt: started,
        payload: {
          ...itemBase,
          id: TurnItemId.make("item:command"),
          type: "command_execution",
          input: body,
          output: body,
        },
      },
      {
        id: EventId.make("event:answer"),
        type: "turn-item.updated",
        threadId,
        occurredAt: started,
        payload: {
          ...itemBase,
          id: TurnItemId.make("item:answer"),
          ordinal: 2,
          type: "assistant_message",
          messageId: MessageId.make("message:answer"),
          text: body,
          streaming: true,
        },
      },
      {
        id: EventId.make("event:message"),
        type: "message.updated",
        threadId,
        occurredAt: started,
        payload: {
          id: MessageId.make("message:answer"),
          threadId,
          runId,
          nodeId: rootId,
          createdBy: "agent",
          creationSource: "provider",
          role: "assistant",
          text: body,
          attachments: [],
          streaming: true,
          createdAt: started,
          updatedAt: started,
        },
      },
      {
        id: EventId.make("event:request"),
        type: "runtime-request.updated",
        threadId,
        occurredAt: started,
        payload: {
          id: RuntimeRequestId.make("request:pending"),
          nodeId: rootId,
          providerTurnId,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId: ProviderSessionId.make("session:retiring"),
          },
          createdAt: started,
          resolvedAt: null,
        },
      },
      {
        id: EventId.make("event:native"),
        type: "subagent.updated",
        threadId,
        occurredAt: started,
        payload: { ...taskBase, id: NodeId.make("task:native"), origin: "provider_native" },
      },
      {
        id: EventId.make("event:app"),
        type: "subagent.updated",
        threadId,
        occurredAt: started,
        payload: {
          ...taskBase,
          id: NodeId.make("task:app"),
          origin: "app_owned",
          completionDelivery: { state: "claimed", observedByRunId: deliveryId },
        },
      },
      {
        id: EventId.make("event:ack"),
        type: "subagent.updated",
        threadId,
        occurredAt: started,
        payload: {
          ...taskBase,
          id: NodeId.make("task:ack"),
          origin: "app_owned",
          completionDelivery: { state: "acknowledged", observedByRunId: runId },
        },
      },
    ];
    for (const event of events) yield* store.apply(event);
    if (completedParent) {
      // Only the app-owned task remains active when the hold captures this parent.
      for (const event of events) {
        const base = { ...event, id: EventId.make(`${event.id}:completed`), occurredAt: retired };
        if (event.type === "run.created" && event.payload.id === runId)
          yield* store.apply({
            ...base,
            type: "run.updated",
            payload: { ...event.payload, status: "completed", completedAt: retired },
          });
        if (event.type === "node.updated" && event.payload.id === rootId)
          yield* store.apply({
            ...base,
            type: "node.updated",
            payload: { ...event.payload, status: "completed", completedAt: retired },
          });
        if (event.type === "run-attempt.created")
          yield* store.apply({
            ...base,
            type: "run-attempt.updated",
            payload: { ...event.payload, status: "completed", completedAt: retired },
          });
        if (event.type === "provider-turn.updated")
          yield* store.apply({
            ...base,
            type: "provider-turn.updated",
            payload: { ...event.payload, status: "completed", completedAt: retired },
          });
        if (event.type === "turn-item.updated")
          yield* store.apply({
            ...base,
            type: "turn-item.updated",
            payload: {
              ...event.payload,
              ...("streaming" in event.payload ? { streaming: false } : {}),
              status: "completed",
              completedAt: retired,
            },
          });
        if (event.type === "message.updated")
          yield* store.apply({
            ...base,
            type: "message.updated",
            payload: { ...event.payload, streaming: false },
          });
        if (event.type === "subagent.updated" && event.payload.origin === "provider_native")
          yield* store.apply({
            ...base,
            type: "subagent.updated",
            payload: { ...event.payload, status: "completed", completedAt: retired },
          });
      }
    }
    const initial = yield* store.getThreadProjection(threadId);
    yield* store.apply({
      id: EventId.make("event:hold"),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: started,
      payload: {
        ...initial.thread,
        executionHandoff: { operationId: "handoff:retirement", recoveryRequired: false },
      },
    });
    if (nativeCompletesFirst)
      yield* store.apply({
        id: EventId.make("event:native-completed"),
        type: "run.updated",
        threadId,
        occurredAt: retired,
        payload: { ...run, status: "completed", completedAt: retired },
      });
    assert.equal((yield* store.getExecutionActors(threadId)).items[0]?.activeRunId, runId);
    assert.equal(
      (yield* store.getExecutionRetirementContext(threadId, runId)).isRetirementTarget,
      true,
    );
    const before = yield* store.getThreadProjection(threadId);
    const event: OrchestrationV2DomainEvent = {
      id: EventId.make("event:retired"),
      type: "run.execution-retired",
      threadId,
      runId,
      occurredAt: retired,
      payload: {
        runId,
        attemptId,
        rootNodeId: rootId,
        providerThreadId,
        cohortParentRunId: runId,
        deliveryRunId: deliveryId,
        operationId: "handoff:retirement",
        retirementEffectId: "effect:retirement",
      },
    };
    yield* store.apply(event);
    const after = yield* store.getThreadProjection(threadId);
    const expected = ProjectionStore.applyToProjection(before, event);
    for (const key of [
      "runs",
      "attempts",
      "nodes",
      "subagents",
      "providerTurns",
      "messages",
      "runtimeRequests",
      "turnItems",
    ] as const)
      assert.deepEqual(after[key], expected[key], key);
    assert.equal(
      after.runs.find((item) => item.id === runId)?.status,
      nativeCompletesFirst || completedParent ? "completed" : "interrupted",
    );
    assert.deepEqual(
      after.runs.find((item) => item.id === queuedId),
      before.runs.find((item) => item.id === queuedId),
    );
    assert.equal(after.runs.find((item) => item.id === deliveryId)?.status, "cancelled");
    assert.deepEqual(after.runs.find((item) => item.id === runId)?.delegatedCompletion, {
      disposition: "stopped",
      nextGeneration: 3,
      delivery: null,
    });
    assert.equal(
      after.turnItems.find((item) => item.id === "item:command")?.status,
      completedParent ? "completed" : "interrupted",
    );
    const command = after.turnItems.find((item) => item.type === "command_execution");
    assert.equal(command?.type === "command_execution" ? command.output : null, body);
    assert.equal(after.messages[0]?.text, body);
    assert.equal(after.messages[0]?.streaming, false);
    const answer = after.turnItems.find((item) => item.type === "assistant_message");
    assert.equal(answer?.type === "assistant_message" ? answer.streaming : null, false);
    assert.equal(after.providerTurns[0]?.tokenUsage?.usedTokens, 123);
    assert.equal(after.runtimeRequests[0]?.responseCapability.type, "not_resumable");
    assert.equal(
      after.subagents.find((task) => task.id === "task:native")?.status,
      completedParent ? "completed" : "interrupted",
    );
    assert.equal(
      after.subagents.find((task) => task.id === "task:app")?.completionDelivery?.state,
      "disposed",
    );
    assert.deepEqual(
      after.subagents.find((task) => task.id === "task:ack"),
      before.subagents.find((task) => task.id === "task:ack"),
    );
    // Replaying the compact event neither rewrites terminal timestamps nor touches held input.
    yield* store.apply(event);
    assert.deepEqual(yield* store.getThreadProjection(threadId), after);
    assert.equal(
      (yield* store.getExecutionRetirementContext(threadId, runId)).isRetirementTarget,
      false,
    );
    assert.equal((yield* store.getExecutionActors(threadId)).items[0]?.activeRunId, null);
    yield* store.apply({
      id: EventId.make("event:release"),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: retired,
      payload: { ...after.thread, executionHandoff: null },
    });
    assert.equal(
      (yield* store.getExecutionRetirementContext(threadId, runId)).isRetirementTarget,
      false,
    );
  });

it.effect("SQL retirement patches preserve bodies, replay, and unrelated held input", () =>
  retirementContract().pipe(Effect.provide(sqlLayer)),
);
it.effect("memory retirement preserves bodies, replay, and unrelated held input", () =>
  retirementContract().pipe(Effect.provide(ProjectionStore.layerMemory)),
);
it.effect("SQL hold retains its original retirement target after native completion", () =>
  retirementContract(true).pipe(Effect.provide(sqlLayer)),
);
it.effect("memory hold retains its original retirement target after native completion", () =>
  retirementContract(true).pipe(Effect.provide(ProjectionStore.layerMemory)),
);
it.effect("SQL hold captures a completed parent with an active app-owned task", () =>
  retirementContract(false, true).pipe(Effect.provide(sqlLayer)),
);
it.effect("memory hold captures a completed parent with an active app-owned task", () =>
  retirementContract(false, true).pipe(Effect.provide(ProjectionStore.layerMemory)),
);
