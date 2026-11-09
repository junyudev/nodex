import { observedTaskResults } from "./DelegatedResultReceipt.ts";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@nodex/runtime-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import { readExecutionHandoff } from "./ExecutionHandoff.ts";
import { questionNoticeId, questionNoticeText } from "./DelegatedTaskQuestions.ts";

export class DelegatedTaskQuestionReactor extends Context.Service<
  DelegatedTaskQuestionReactor,
  {
    readonly recover: () => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("nodex/orchestration-v2/DelegatedTaskQuestionReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;

  const wakeParent = Effect.fnUntraced(function* (
    task: OrchestrationV2Subagent,
    request: OrchestrationV2RuntimeRequest,
    sourceRunOrdinal: number | undefined,
    workStoppedThroughOrdinal: number | undefined,
  ) {
    if (task.childThreadId === null || request.questionHandoff !== undefined) return;
    const receipt = task.questionDeliveries?.find((receipt) => receipt.requestId === request.id);
    const owner = yield* projections.getThreadRecords(task.threadId, ["runs", "messages"], {
      runIds: [
        ...new Set([
          ...(task.runId === null ? [] : [task.runId]),
          ...(receipt === undefined ? [] : [receipt.runId]),
        ]),
      ],
      messageIds: [questionNoticeId(task.threadId, request.id)],
    });
    const notice = owner.messages[0];
    const noticeRuns =
      notice?.runId == null
        ? []
        : (yield* projections.getThreadRecords(task.threadId, ["runs"], { runIds: [notice.runId] }))
            .runs;
    const received =
      task.receivedQuestionIds?.includes(request.id) &&
      !task.unconfirmedQuestionIds?.includes(request.id);
    const receivingRun = received
      ? owner.runs.find((run) => run.id === receipt?.runId)
      : notice?.delivery === "accepted"
        ? noticeRuns[0]
        : undefined;
    const ownerRun = owner.runs.find((run) => run.id === task.runId);
    const stopped =
      (ownerRun !== undefined &&
        owner.thread.executionStoppedThroughOrdinal !== undefined &&
        ownerRun.ordinal <= owner.thread.executionStoppedThroughOrdinal) ||
      (sourceRunOrdinal !== undefined &&
        workStoppedThroughOrdinal !== undefined &&
        sourceRunOrdinal <= workStoppedThroughOrdinal);
    const unavailable =
      stopped ||
      owner.thread.archivedAt !== null ||
      owner.thread.deletedAt !== null ||
      task.completionDelivery?.state === "disposed" ||
      owner.runs.some(
        (run) =>
          run.id === task.runId &&
          ["stopped", "disposed"].includes(run.delegatedCompletion?.disposition ?? ""),
      );
    const terminal =
      receivingRun !== undefined &&
      ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
        receivingRun.status,
      );
    const held =
      (yield* projections.isExecutionPaused(task.threadId)) ||
      (yield* readExecutionHandoff(projections, task.threadId)) !== null;
    if (!unavailable && held) return;
    if (unavailable || terminal) {
      yield* engine.dispatch({
        type: "delegated_task.question-handoff",
        commandId: CommandId.make(`server:question-handoff:${task.childThreadId}:${request.id}`),
        threadId: task.childThreadId,
        requestId: request.id,
        reason: unavailable ? "owner_unavailable" : "unresolved",
      });
      return;
    }
    if (task.receivedQuestionIds?.includes(request.id)) return;
    const parent = yield* projections.getThreadRecords(task.threadId, ["runs", "messages"], {
      messageIds: [questionNoticeId(task.threadId, request.id)],
      runStatuses: ["preparing", "starting", "running", "waiting"],
    });
    if (
      parent.thread.archivedAt !== null ||
      parent.thread.deletedAt !== null ||
      parent.messages.length > 0
    )
      return;
    if (
      parent.runs.some(
        (run) =>
          ["preparing", "starting", "running"].includes(run.status) &&
          run.id === task.runId &&
          (run.taskQuestionWaits?.length ?? 0) > 0,
      )
    )
      return;
    const context = yield* projections.getRuntimeResponseContext(task.childThreadId, request.id);
    const child = { turnItems: context.item === undefined ? [] : [context.item] };
    // Requests and their question items may arrive in separate provider transactions.
    if (
      !child.turnItems.some(
        (item) => item.type === "user_input_request" && item.requestId === request.id,
      )
    )
      return;
    const key = `${task.threadId}:${request.id}`;
    const sequence = yield* engine.getThreadEventSequence(task.threadId);
    yield* engine.dispatch({
      type: "message.dispatch",
      // A wait can win the lock after the read above. A later parent state may retry
      // that no-op receipt, while the stable message identity prevents duplicate delivery.
      commandId: CommandId.make(`server:delegated-task-question:${key}:${sequence}`),
      threadId: task.threadId,
      messageId: questionNoticeId(task.threadId, request.id),
      delegatedQuestion: { taskId: task.id, requestId: request.id },
      text: questionNoticeText(task, request, child.turnItems),
      notification: {
        source: { kind: "delegated_task", taskIds: [task.id], childThreadId: task.childThreadId },
        outcome: "updated",
        summary: "Delegated task has a question",
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const catchUpChild = Effect.fnUntraced(function* (childId: ThreadId) {
    const child = yield* projections.getThreadRecords(childId, ["runtimeRequests"], {
      pendingUserQuestions: true,
    });
    const nodes = yield* projections.getThreadRecords(childId, ["nodes"], {
      nodeIds: child.runtimeRequests.map((request) => request.nodeId),
    });
    const runIds = [
      ...new Set(nodes.nodes.flatMap((node) => (node.runId === null ? [] : [node.runId]))),
    ];
    const runs = yield* projections.getThreadRecords(childId, ["runs"], { runIds });
    const parentId = child.thread.lineage.parentThreadId;
    if (parentId === null) return;
    const taskIds = [
      ...new Set(
        runs.runs.flatMap((run) =>
          run.delegatedTaskId === undefined ? [] : [run.delegatedTaskId],
        ),
      ),
    ];
    if (child.thread.forkedFrom?.type === "node") taskIds.push(child.thread.forkedFrom.nodeId);
    const parent = yield* projections.getThreadRecords(parentId, ["subagents"], {
      subagentIds: taskIds,
    });
    for (const request of child.runtimeRequests) {
      const runId = nodes.nodes.find((node) => node.id === request.nodeId)?.runId;
      const run = runs.runs.find((run) => run.id === runId);
      const taskId =
        run?.delegatedTaskId ??
        (child.thread.forkedFrom?.type === "node" ? child.thread.forkedFrom.nodeId : undefined);
      const task = parent.subagents.find(
        (task) =>
          task.origin === "app_owned" && task.id === taskId && task.childThreadId === childId,
      );
      if (task === undefined || request.kind !== "user_input") continue;
      yield* wakeParent(task, request, run?.ordinal, child.thread.executionStoppedThroughOrdinal);
    }
  });

  const acceptNativeQuestions = Effect.fnUntraced(function* (item: OrchestrationV2TurnItem) {
    const observation = observedTaskResults(item);
    if (
      observation?.questions === undefined ||
      observation.questions.length === 0 ||
      observation.threadId !== item.threadId ||
      observation.runId !== item.runId ||
      item.providerTurnId === null
    )
      return;
    const records = yield* projections.getThreadRecords(
      item.threadId,
      ["runs", "attempts", "providerThreads", "providerTurns"],
      {
        runIds: [observation.runId],
        attemptIds: [observation.attemptId],
        providerThreadIds: [observation.providerThreadId],
        providerTurnAttemptIds: [observation.attemptId],
      },
    );
    if (
      records.runs[0]?.activeAttemptId !== observation.attemptId ||
      records.runs[0]?.providerThreadId !== observation.providerThreadId ||
      records.attempts[0]?.nativeThreadId !== observation.nativeThreadId ||
      records.providerThreads[0]?.nativeThreadRef?.nativeId !== observation.nativeThreadId ||
      !records.providerTurns.some((turn) => turn.id === item.providerTurnId)
    )
      return;
    for (const question of observation.questions) {
      yield* engine.dispatch({
        type: "delegated_task.question-delivery",
        commandId: CommandId.make(
          `server:question-native-receipt:${item.id}:${question.taskId}:${question.requestId}`,
        ),
        parentThreadId: item.threadId,
        taskId: question.taskId,
        requestId: question.requestId,
        outcome: "received",
      });
    }
  });

  /** Invalidate the task's bounded overview when a request changes, including async questions. */
  const refreshTaskAttention = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { type: "runtime-request.updated" }>,
  ) {
    const child = yield* projections.getThreadRecords(event.threadId, ["nodes"], {
      nodeIds: [event.payload.nodeId],
    });
    const runIds = child.nodes.flatMap((node) => (node.runId === null ? [] : [node.runId]));
    const records = yield* projections.getThreadRecords(event.threadId, ["runs", "subagents"], {
      runIds,
      subagentRunIds: runIds,
    });
    const taskId =
      records.runs[0]?.delegatedTaskId ??
      (child.thread.forkedFrom?.type === "node" ? child.thread.forkedFrom.nodeId : undefined);
    const targets = records.subagents
      .filter(
        (task) =>
          task.origin === "provider_native" &&
          child.nodes.some(
            (node) =>
              node.providerThreadId !== null && node.providerThreadId === task.providerThreadId,
          ),
      )
      .map((task) => ({ parentThreadId: event.threadId, taskId: task.id }));
    if (child.thread.lineage.parentThreadId !== null && taskId !== undefined)
      targets.push({ parentThreadId: child.thread.lineage.parentThreadId, taskId });
    for (const target of targets)
      yield* engine.dispatch({
        type: "delegated_task.attention-changed",
        commandId: CommandId.make(`server:task-attention:${event.id}:${target.taskId}`),
        ...target,
      });
  });

  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (
        event.type === "runtime-request.updated" &&
        !["dynamic_tool_call", "auth_refresh"].includes(event.payload.kind)
      )
        yield* refreshTaskAttention(event);
      if (
        event.type === "turn-item.updated" &&
        event.payload.type === "dynamic_tool" &&
        event.payload.status === "completed"
      ) {
        // Bounded event streams omit tool output. Read only this canonical receipt item.
        const item = yield* projections.getTurnItem({
          threadId: event.threadId,
          itemId: event.payload.id,
        });
        if (item !== null) yield* acceptNativeQuestions(item);
        return;
      }
      if (
        event.type === "run.updated" ||
        event.type === "subagent.updated" ||
        event.type === "thread.archived" ||
        event.type === "thread.deleted" ||
        event.type === "thread.metadata-updated" ||
        event.type === "message.updated" ||
        event.type === "message.delivery.updated" ||
        (event.type === "turn-item.updated" && event.payload.type === "run_interrupt_request")
      ) {
        const children = yield* projections.getRecoveryThreadIds("delegated-questions");
        for (const childId of children) {
          const child = yield* projections.getThread(childId);
          if (childId === event.threadId || child.lineage.parentThreadId === event.threadId)
            yield* catchUpChild(childId);
        }
        return;
      }
      if (event.type === "runtime-request.updated" && event.payload.kind === "user_input") {
        const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
        if (request?.status === "pending") return yield* catchUpChild(event.threadId);
        const child = yield* projections.getThread(event.threadId);
        const parentId = child.lineage.parentThreadId;
        if (parentId === null) return;
        const parent = yield* projections.getThreadRecords(parentId, ["runs"], {
          runStatuses: ["queued"],
        });
        const queued = parent.runs.find(
          (run) => run.userMessageId === questionNoticeId(parentId, event.payload.id),
        );
        if (queued !== undefined)
          yield* engine.dispatch({
            type: "queued-run.cancel-internal",
            commandId: CommandId.make(
              `server:delegated-task-question-cancel:${parentId}:${event.payload.id}`,
            ),
            threadId: parentId,
            runId: queued.id,
          });
        return;
      }
      if (
        (event.type === "runtime-request.updated" && event.payload.kind === "user_input") ||
        (event.type === "turn-item.updated" && event.payload.type === "user_input_request")
      )
        yield* catchUpChild(event.threadId);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking the parent of a delegated task question failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  // No MCP call from the previous Runtime process can still own a wait.
  const releaseAbandonedWaits = Effect.fnUntraced(function* (parentId: ThreadId) {
    const parent = yield* projections.getThreadRecords(parentId, ["runs"], {
      runStatuses: ["preparing", "starting", "running", "waiting"],
    });
    for (const run of parent.runs) {
      for (const waitId of run.taskQuestionWaits ?? []) {
        yield* engine.dispatch({
          type: "delegated_task.question-wait",
          commandId: CommandId.make(`server:question-wait-recover:${run.id}:${waitId}`),
          parentThreadId: parentId,
          parentRunId: run.id,
          waitId,
          active: false,
        });
      }
    }
  });

  const recoverWaitReceipts = Effect.fnUntraced(function* (
    parentId: ThreadId,
    taskIds: ReadonlyArray<OrchestrationV2Subagent["id"]>,
  ) {
    const parent = yield* projections.getThreadRecords(parentId, ["subagents"], {
      subagentIds: taskIds,
    });
    const uncertain = parent.subagents.filter(
      (task) => (task.unconfirmedQuestionIds?.length ?? 0) > 0,
    );
    const runIds = [...new Set(uncertain.flatMap((task) => task.questionClaimRunIds ?? []))];
    if (runIds.length > 0) {
      const history = yield* projections.getThreadRecords(parentId, ["turnItems"], {
        turnItemRunIds: runIds,
        turnItemTypes: ["dynamic_tool"],
        turnItemStatuses: ["completed"],
      });
      for (const item of history.turnItems) yield* acceptNativeQuestions(item);
    }
    const current = yield* projections.getThreadRecords(parentId, ["subagents"], {
      subagentIds: uncertain.map((task) => task.id),
    });
    for (const task of current.subagents) {
      for (const requestId of task.unconfirmedQuestionIds ?? []) {
        const sequence = yield* engine.getThreadEventSequence(parentId);
        yield* engine.dispatch({
          type: "delegated_task.question-delivery",
          commandId: CommandId.make(`server:question-retry:${task.id}:${requestId}:${sequence}`),
          parentThreadId: parentId,
          taskId: task.id,
          requestId,
          outcome: "retry",
        });
      }
    }
  });

  const recover = () =>
    Effect.gen(function* () {
      const children = yield* projections.getRecoveryThreadIds("delegated-questions");
      const parents = new Set<ThreadId>();
      const pendingTasks = new Map<ThreadId, Set<OrchestrationV2Subagent["id"]>>();
      for (const childId of children) {
        const child = yield* projections.getThread(childId);
        parents.add(childId);
        if (child.lineage.parentThreadId === null) continue;
        parents.add(child.lineage.parentThreadId);
        const requests = yield* projections.getThreadRecords(childId, ["runtimeRequests"], {
          pendingUserQuestions: true,
        });
        const nodes = yield* projections.getThreadRecords(childId, ["nodes"], {
          nodeIds: requests.runtimeRequests.map((request) => request.nodeId),
        });
        const runs = yield* projections.getThreadRecords(childId, ["runs"], {
          runIds: nodes.nodes.flatMap((node) => (node.runId === null ? [] : [node.runId])),
        });
        const taskIds =
          pendingTasks.get(child.lineage.parentThreadId) ??
          new Set<OrchestrationV2Subagent["id"]>();
        for (const run of runs.runs)
          if (run.delegatedTaskId !== undefined) taskIds.add(run.delegatedTaskId);
        if (child.forkedFrom?.type === "node") taskIds.add(child.forkedFrom.nodeId);
        pendingTasks.set(child.lineage.parentThreadId, taskIds);
      }
      for (const parentId of parents) {
        yield* releaseAbandonedWaits(parentId);
        yield* recoverWaitReceipts(parentId, [...(pendingTasks.get(parentId) ?? [])]);
      }
      for (const childId of children)
        yield* catchUpChild(childId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("recovering a delegated task question failed", { childId, cause }),
          ),
        );
      yield* engine.resumeQueuedRuns;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("delegated task question recovery failed", { cause }),
      ),
    );

  const start: DelegatedTaskQuestionReactor["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // Capture before sweeping, then replay only events committed during/after the sweep.
        const afterSequence = yield* sink.latestSequence();
        yield* recover();
        yield* Stream.runForEach(
          engine.streamStoredEventsFrom({ afterSequence, capturedCursor: true }),
          ({ event }) => handle(event),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task question recovery failed", { cause }),
        ),
      ),
    );

  return { start, handle, recover } satisfies DelegatedTaskQuestionReactor["Service"];
});
export const layer = Layer.effect(DelegatedTaskQuestionReactor, make);
