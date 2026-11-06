import type {
  InboxDecision,
  InboxMessage,
  InboxProposal,
  InboxProposalAction,
} from "@nodex/mobile-protocol";

import type { IconName } from "../../ui/icons";

/** What puts a decision back when it clears a message without a Host undo of its own. */
export const decisionReversal = (decision: InboxDecision): InboxDecision | null =>
  decision.type === "done" || decision.type === "keep" ? { type: "reopen" } : null;

/** The one decision a suggestion asks for: its verb and glyph, wherever it is offered. */
export const proposalAction = (
  action: InboxProposalAction,
): { readonly label: string; readonly icon: IconName } => {
  switch (action.type) {
    case "new_chat":
      return { label: "Start chat", icon: "chat" };
    case "send_to_chat":
      return { label: "Send to chat", icon: "chat" };
    case "move_to_project":
      return { label: "Move", icon: "folder" };
    case "run_task":
      return { label: "Run task", icon: "tool" };
    case "keep":
      return { label: "Keep", icon: "check" };
  }
};

/** Where a suggestion would put the message, for the line beneath its summary. */
export const proposalDestination = (action: InboxProposalAction): string | null => {
  switch (action.type) {
    case "new_chat":
      return action.projectName ?? "Library";
    case "send_to_chat":
      return action.chatTitle;
    case "move_to_project":
      return action.projectName;
    case "run_task":
      return action.name;
    case "keep":
      return null;
  }
};

/** What accepting a suggestion will do, in one line. */
export const proposalHeadline = (action: InboxProposalAction): string => {
  switch (action.type) {
    case "new_chat":
      return action.projectName ? `Start a chat in ${action.projectName}` : "Start a chat";
    case "send_to_chat":
      return action.chatTitle ? `Send to ${action.chatTitle}` : "Send to a chat";
    case "move_to_project":
      return action.projectName ? `Move to ${action.projectName}` : "Move to a Project";
    case "run_task":
      return action.name ? `Run ${action.name}` : "Run this task";
    case "keep":
      return "Keep as a Page";
  }
};

/** Who a suggestion comes from, for the line that labels it. */
export const proposalAttribution = ({
  origin,
  producedBy,
}: Pick<InboxProposal, "origin" | "producedBy">): string => {
  if (origin === "schedule") return "From your scheduled task";
  return producedBy ? `Suggested by ${producedBy}` : "Suggestion";
};

/** The decision that authorizes a suggestion exactly as it was shown, and how it is confirmed. */
export const proposalAcceptance = (
  proposal: InboxProposal,
): { readonly decision: InboxDecision; readonly done: string } => ({
  decision: { type: "accept", proposalId: proposal.proposalId, revision: proposal.revision },
  done: proposal.action.type === "keep" ? "Kept" : "Done",
});

export type SuggestionView =
  | { readonly kind: "none" }
  | { readonly kind: "thinking" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "dispatching" }
  | { readonly kind: "dispatch-failed"; readonly proposal: InboxProposal; readonly message: string }
  | { readonly kind: "offer"; readonly proposal: InboxProposal };

/**
 * What a stream row says about a message's advice. A suggestion that can still be confirmed stays
 * on offer while fresh advice runs, since the person may want the earlier one.
 */
export const suggestionView = (message: InboxMessage): SuggestionView => {
  const { proposal, suggestion } = message;
  if (proposal?.state === "dispatching") return { kind: "dispatching" };
  if (proposal?.state === "failed") {
    return {
      kind: "dispatch-failed",
      proposal,
      message: proposal.failureMessage ?? "It could not be delivered.",
    };
  }
  if (proposal?.state === "open") return { kind: "offer", proposal };
  if (suggestion.state === "waiting" || suggestion.state === "pending") return { kind: "thinking" };
  if (suggestion.state === "failed") {
    return { kind: "failed", message: suggestion.error ?? "No suggestion could be made." };
  }
  return { kind: "none" };
};

const OUTCOME_LABELS: Readonly<Record<NonNullable<InboxMessage["outcome"]>, string>> = {
  kept: "Kept",
  done: "Done",
  moved: "Moved",
  chat: "Sent to chat",
};

/** The handled state a processed message shows. */
export const outcomeLabel = (message: InboxMessage): string | null =>
  message.outcome ? OUTCOME_LABELS[message.outcome] : null;

/** Who a message came from, when it was not the person themself. */
export const sourceLabel = (message: InboxMessage): string | null =>
  message.source.kind === "user" ? null : message.source.label;
