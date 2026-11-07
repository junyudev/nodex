import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
} from "@nodex/runtime-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class DelegatedTaskQuestionReactor extends Context.Service<
  DelegatedTaskQuestionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("nodex/orchestration-v2/DelegatedTaskQuestionReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const wakeParent = Effect.fnUntraced(function* (
    task: OrchestrationV2Subagent,
    request: OrchestrationV2RuntimeRequest,
  ) {
    if (task.childThreadId === null) return;
    const key = `${task.threadId}:${request.id}`;
    const situation =
      request.responseCapability.type === "message"
        ? `Delegated task ${task.id} asked a question and is still working.`
        : `Delegated task ${task.id} is blocked on a question and cannot continue until it is answered.`;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:delegated-task-question:${key}`),
      threadId: task.threadId,
      messageId: MessageId.make(`message:delegated-task-question:${key}`),
      text: `${situation} Read it with task_question action read, taskId ${task.id}, and requestId ${request.id}. Use action respond with answers when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`,
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

  const catchUpParent = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { readonly type: "run.updated" }>,
  ) {
    if (!["completed", "failed", "waiting"].includes(event.payload.status)) return;
    const parent = yield* projections.getThreadRecords(event.threadId, ["subagents"], {
      subagentRunIds: [event.payload.id],
    });
    if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
    for (const task of parent.subagents) {
      if (
        task.origin !== "app_owned" ||
        task.runId !== event.payload.id ||
        task.completionWake !== "settled_only" ||
        task.completionDelivery?.state === "disposed" ||
        task.childThreadId === null ||
        ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
      ) {
        continue;
      }
      const child = yield* projections.getThreadRecords(task.childThreadId, ["runtimeRequests"]);
      for (const request of child.runtimeRequests) {
        if (
          request.kind !== "user_input" ||
          request.status !== "pending" ||
          request.responseCapability.type !== "live"
        ) {
          continue;
        }
        yield* wakeParent(task, request).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("catching up a delegated task question failed", {
              taskId: task.id,
              requestId: request.id,
              cause,
            }),
          ),
        );
      }
    }
  });

  // Runs for every domain event; most events return before any work is needed.
  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") return yield* catchUpParent(event);
      if (event.type !== "runtime-request.updated" || event.payload.kind !== "user_input") {
        return;
      }
      const child = yield* projections.getThread(event.threadId);
      const parentThreadId = child.lineage.parentThreadId;
      if (parentThreadId === null) return;
      const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
      const key = `${parentThreadId}:${event.payload.id}`;
      const messageId = MessageId.make(`message:delegated-task-question:${key}`);
      if (event.payload.status !== "pending" || request?.status !== "pending") {
        const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"], {
          runStatuses: ["queued"],
        });
        const queued = parent.runs.find(
          (run) => run.status === "queued" && run.userMessageId === messageId,
        );
        if (queued !== undefined) {
          yield* engine.dispatch({
            type: "queued-run.cancel-internal",
            commandId: CommandId.make(`server:delegated-task-question-cancel:${key}`),
            threadId: parentThreadId,
            runId: queued.id,
          });
        }
        return;
      }
      const { runs } = yield* projections.getThreadRecords(
        child.id,
        ["runs"],
        event.runId === undefined ? { runOrder: "desc", runLimit: 1 } : { runIds: [event.runId] },
      );
      const run =
        runs[0] ??
        (yield* projections.getThreadRecords(child.id, ["runs"], { runOrder: "desc", runLimit: 1 }))
          .runs[0];
      const taskId =
        run?.delegatedTaskId ??
        (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined);
      if (taskId === undefined) return;
      const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents"], {
        subagentIds: [taskId],
      });
      const task = parent.subagents.find(
        (candidate) => candidate.origin === "app_owned" && candidate.id === taskId,
      );
      if (
        task === undefined ||
        task.completionDelivery?.state === "disposed" ||
        parent.thread.archivedAt !== null ||
        parent.thread.deletedAt !== null
      ) {
        return;
      }
      if (
        task.completionWake !== "settled_only" ||
        event.payload.responseCapability.type !== "live" ||
        task.runId === null
      )
        return yield* wakeParent(task, request);
      // A blocking delegate_task wait delivers the question itself.
      const parentRuns = yield* projections.getThreadRecords(parentThreadId, ["runs"], {
        runIds: [task.runId],
      });
      if (
        parentRuns.runs.some(
          (run) =>
            run.status === "preparing" || run.status === "starting" || run.status === "running",
        )
      )
        return;
      yield* wakeParent(task, request);
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

  const start: DelegatedTaskQuestionReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task question event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies DelegatedTaskQuestionReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskQuestionReactor, make);
