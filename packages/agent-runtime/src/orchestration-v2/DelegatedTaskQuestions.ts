import {
  MessageId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Subagent,
  type RuntimeRequestId,
  type ThreadId,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";

/** One durable identity, shared by wait consumption, notices, cancellation and recovery. */
export const questionNoticeId = (parentId: ThreadId, requestId: RuntimeRequestId) =>
  MessageId.make(`message:delegated-task-question:${parentId}:${requestId}`);

export function pendingTaskQuestions(
  requests: readonly OrchestrationV2RuntimeRequest[],
  items: readonly OrchestrationV2TurnItem[],
) {
  return requests
    .filter((request) => request.kind === "user_input" && request.status === "pending")
    .map((request) => {
      const item = items.find(
        (item) => item.type === "user_input_request" && item.requestId === request.id,
      );
      return {
        requestId: request.id,
        blocking: request.responseCapability.type === "live",
        askedAt: DateTime.formatIso(request.createdAt),
        preview:
          item?.type === "user_input_request"
            ? item.questions
                .map((q) => q.question)
                .join("; ")
                .slice(0, 500)
            : "Question details available through task_question read.",
      };
    });
}

/** Bound the payload without silently truncating question or option text. */
export function questionNoticeText(
  task: OrchestrationV2Subagent,
  request: OrchestrationV2RuntimeRequest,
  items: readonly OrchestrationV2TurnItem[],
) {
  const item = items.find(
    (item) => item.type === "user_input_request" && item.requestId === request.id,
  );
  const detail = item?.type === "user_input_request" ? JSON.stringify(item.questions) : "";
  const inline =
    detail && Buffer.byteLength(detail) <= 12_000
      ? `Questions: ${detail}`
      : `The questions are too long to include; read them with task_question action read, taskId ${task.id}, requestId ${request.id}.`;
  const blocked = request.responseCapability.type === "live";
  return [
    `Delegated task "${task.title ?? "Untitled"}" (${task.id}) ${blocked ? "is blocked until you answer" : "asked a question and keeps working"}.`,
    `requestId: ${request.id}`,
    inline,
    `Answer with task_question action respond, taskId ${task.id}, requestId ${request.id}, answers keyed by question id. If only the user can decide, ask them, then respond.`,
    blocked
      ? "The task stays blocked until you answer or cancel it."
      : "If the question no longer matters, use action dismiss.",
  ].join("\n");
}
