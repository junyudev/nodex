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
  ) {
    if (
      task.childThreadId === null ||
      task.receivedQuestionIds?.includes(request.id) ||
      task.completionDelivery?.state === "disposed"
    )
      return;
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
      yield* wakeParent(task, request);
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

  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
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
      if (event.type === "run.updated") {
        const parent = yield* projections.getThreadRecords(event.threadId, ["subagents"], {
          subagentRunIds: [event.payload.id],
        });
        for (const childId of new Set(
          parent.subagents
            .filter((task) => task.origin === "app_owned")
            .flatMap((task) => (task.childThreadId === null ? [] : [task.childThreadId])),
        ))
          yield* catchUpChild(childId);
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
