import type { components } from "@nodex/core-protocol";
import type { InboxReplyDestination } from "../../shared/inbox";

type Control = import("effect/Effect").Success<
  ReturnType<AgentRuntimeApplication["Service"]["control"]>
>;
type Details = NonNullable<
  import("effect/Effect").Success<
    ReturnType<AgentRuntimeApplication["Service"]["observeSessionMetadata"]>
  >
>["details"];
export type ReplyDispatch = components["schemas"]["InboxReplyDispatch"];

/** A queued message cannot resolve a provider's live question or approval. */
export const decideInboxReply = (
  purpose: "result" | "attention" | "problem",
  body: string,
  control: Control,
  details: Pick<Details, "pendingRequests">,
): ReplyDispatch | null => {
  const { runtimeRequests, nodes } = control.snapshot.projection;
  const pending = runtimeRequests.filter((request) => request.status === "pending");
  if (pending.length === 0) return { type: "send" };
  if (purpose !== "attention" || pending.length !== 1) return null;
  const request = pending[0]!;
  if (request.kind !== "user_input" || request.responseCapability.type === "not_resumable")
    return null;
  // Control reads deliberately omit transcript items. Metadata owns the question envelope;
  // the exact pending control request and its node retain answer authority.
  const pendingQuestion = details.pendingRequests.find(
    (candidate) => candidate.kind === "question" && candidate.id === request.id,
  );
  if (pendingQuestion?.questions.length !== 1) return null;
  const question = pendingQuestion.questions[0]!;
  const option = question.options.find(
    (option) => option.label.toLowerCase() === body.trim().toLowerCase(),
  );
  if (!option && question.options.length > 0 && question.allowCustomAnswer === false) return null;
  if (!body.trim()) return null;
  const node = nodes.find((node) => node.id === request.nodeId);
  if (!node || node.threadId !== control.threadId) return null;
  return {
    type: "answer",
    response: {
      request_id: request.id,
      run_id: node.runId,
      question_id: question.id,
      answer: option?.label ?? body,
    },
  };
};

export const inboxReplyDestination = (
  chat: { readonly sessionId: string; readonly title: string } | null,
  dispatch: ReplyDispatch | null,
): InboxReplyDestination => ({
  kind: dispatch?.type ?? "nodex",
  chat,
});
