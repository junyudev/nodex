import type {
  InboxDecision,
  InboxEntry,
  InboxProposal,
  InboxProposalAction,
} from "@nodex/mobile-protocol";

import type { IconName } from "../../ui/icons";
import { formatLaterTime, formatSetAsideDate } from "./inbox-later-time";

/** What puts a decision back when it clears a message without a Host undo of its own. */
export const decisionReversal = (decision: InboxDecision): InboxDecision | null =>
  decision.type === "later" ? { type: "clear_later" } : null;

/** The one decision a suggestion asks for: its verb and glyph, wherever it is offered. */
export const proposalAction = (
  action: InboxProposalAction,
  now = new Date(),
): { readonly label: string; readonly icon: IconName } => {
  switch (action.type) {
    case "new_chat":
      return { label: "Start chat", icon: "chat" };
    case "send_to_chat":
      return { label: "Send to chat", icon: "chat" };
    case "move_to_project":
      return { label: "Move", icon: "folder" };
    case "execute_decision":
      return { label: "Run", icon: "tool" };
    case "plan":
      return { label: "Start plan", icon: "tool" };
    case "later":
      return { label: `Later · ${formatLaterTime(action.remindAt, now)}`, icon: "clock" };
    case "keep":
      return { label: "Add to Todo", icon: "check" };
    case "save_to_notes":
      return { label: "Save to Notes", icon: "folder" };
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
    case "execute_decision":
      return action.name;
    case "plan":
      return null;
    case "later":
    case "save_to_notes":
    case "keep":
      return null;
  }
};

/** What accepting a suggestion will do, in one line. */
export const proposalHeadline = (action: InboxProposalAction, now = new Date()): string => {
  switch (action.type) {
    case "new_chat":
      return action.projectName ? `Start a chat in ${action.projectName}` : "Start a chat";
    case "send_to_chat":
      return action.chatTitle ? `Send to ${action.chatTitle}` : "Send to a chat";
    case "move_to_project":
      return action.projectName ? `Move to ${action.projectName}` : "Move to a Project";
    case "execute_decision":
      return action.name ? `Run ${action.name}` : "Run this Automation";
    case "plan":
      return "Start a plan";
    case "later":
      return proposalAction(action, now).label;
    case "keep":
      return "Add to Todo";
    case "save_to_notes":
      return "Save to Notes";
  }
};

/** Who a suggestion comes from, for the line that labels it. */
export const proposalAttribution = ({
  origin,
  producedBy,
}: Pick<InboxProposal, "origin" | "producedBy">): string => {
  if (origin === "automation") return "From your Automation";
  return producedBy ? `Suggested by ${producedBy}` : "Suggestion";
};

/** The decision that authorizes a suggestion exactly as it was shown, and how it is confirmed. */
export const proposalSkills = (proposal: InboxProposal) =>
  proposal.action.type === "new_chat" || proposal.action.type === "send_to_chat"
    ? (proposal.action.skills ?? [])
    : [];

export const proposalAcceptance = (
  proposal: InboxProposal,
  droppedSkillNames: readonly string[] = [],
): { readonly decision: InboxDecision; readonly done: string } => ({
  decision: {
    type: "accept",
    proposalId: proposal.proposalId,
    revision: proposal.revision,
    ...(proposalSkills(proposal).length
      ? {
          keptSkillNames: proposalSkills(proposal)
            .filter(({ name }) => !droppedSkillNames.includes(name))
            .map(({ name }) => name),
        }
      : {}),
  },
  done:
    proposal.action.type === "later"
      ? "Set aside"
      : proposal.action.type === "keep"
        ? "Added to Todo"
        : proposal.action.type === "save_to_notes"
          ? "Saved to Notes"
          : "Done",
});

export type SuggestionView =
  | { readonly kind: "none" }
  | { readonly kind: "thinking" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "dispatching" }
  | {
      readonly kind: "dispatch-failed";
      readonly proposal: InboxProposal;
      /** Whether it failed, or may have arrived without confirmation. */
      readonly headline: string;
      readonly message: string;
      /** Retry is offered only where the Space accepts it; anything else needs a new decision. */
      readonly retry: boolean;
    }
  | { readonly kind: "offer"; readonly proposal: InboxProposal };

/**
 * What a stream row says about a message's advice. A suggestion that can still be confirmed stays
 * on offer while fresh advice runs, since the person may want the earlier one. A delivery whose
 * arrival is unconfirmed is no longer in progress: it waits for the person to check its chat.
 */
export const suggestionView = (message: InboxEntry): SuggestionView => {
  if (message.rowKind !== "intake") return { kind: "none" };
  const { proposal, suggestion } = message;
  const uncertain = proposal?.failureKind === "unknown";
  if (proposal?.state === "dispatching" && !uncertain) return { kind: "dispatching" };
  if (proposal?.state === "failed" || (proposal?.state === "dispatching" && uncertain)) {
    return {
      kind: "dispatch-failed",
      proposal,
      headline: uncertain
        ? "Delivery not confirmed"
        : proposal.action.type === "execute_decision"
          ? "Couldn't run"
          : "Couldn't deliver",
      message: proposal.failureMessage ?? "It could not be delivered.",
      retry: proposal.retryable,
    };
  }
  if (proposal?.state === "open") return { kind: "offer", proposal };
  if (suggestion.state === "waiting" || suggestion.state === "pending") return { kind: "thinking" };
  if (suggestion.state === "failed") {
    return { kind: "failed", message: suggestion.error ?? "No suggestion could be made." };
  }
  return { kind: "none" };
};

/** The Page Status shown beside an intake message in Handled. */
export function outcomeLabel(message: InboxEntry): string | null {
  if (message.rowKind !== "intake" || message.waiting) return null;
  const action = message.proposal?.action.type;
  if (message.proposal?.state === "completed") {
    if (action === "new_chat" || action === "send_to_chat") return "Sent to chat";
    if (action === "move_to_project") return "Moved";
    if (action === "keep") return "Added to Todo";
    if (action === "save_to_notes") return "Saved to Notes";
  }
  return message.status === "done" ? "Done" : null;
}

/** Show when an Inbox row returns or when it was set aside. */
export function laterLabel(message: InboxEntry, now: Date): string | null {
  if ((message.rowKind !== "intake" && message.rowKind !== "turn") || !message.later) return null;
  const { later } = message;
  return Date.parse(later.until) > now.getTime()
    ? formatLaterTime(later.until, now)
    : `Back from Later · set aside ${formatSetAsideDate(new Date(later.setAt), now)}`;
}

/** Who a message came from, when it was not the person themself. */
export const sourceLabel = (message: InboxEntry): string | null =>
  message.source.kind === "user" ? null : message.source.label;

export interface EntrySignature {
  readonly label: string;
  readonly icon: IconName;
  /** Asks for the person read warm, reviews read as the accent, trouble reads as danger. */
  readonly tone: "warning" | "accent" | "danger" | "ink-3";
}

type TurnReason = NonNullable<Extract<InboxEntry, { rowKind: "turn" }>["turn"]["reason"]>;

/**
 * An Inbox turn is always the reader's own, so it reads as the desktop words it for its reader:
 * "Needs your answer", "Ready for your review". Keep these words the desktop's.
 */
const TURN_SIGNATURES: Readonly<Record<TurnReason, EntrySignature>> = {
  triage: { label: "Needs your decision", icon: "chat", tone: "warning" },
  delivery_recovery: { label: "Delivery needs your attention", icon: "warning", tone: "danger" },
  question: { label: "Needs your answer", icon: "chat", tone: "warning" },
  approval: { label: "Needs your approval", icon: "warning", tone: "warning" },
  review: { label: "Ready for your review", icon: "check", tone: "accent" },
  ready_to_start: { label: "Ready to start", icon: "clock", tone: "ink-3" },
  blocked: { label: "Blocked · needs you", icon: "warning", tone: "danger" },
  failed: { label: "Failed · needs you", icon: "warning", tone: "danger" },
  stalled: { label: "Stalled · needs you", icon: "warning", tone: "danger" },
  waiting_on_prerequisite: { label: "Waiting for another Page", icon: "clock", tone: "ink-3" },
  paused: { label: "Paused", icon: "stop", tone: "ink-3" },
  working: { label: "The Agent is working", icon: "agent", tone: "ink-3" },
  queued: { label: "Queued", icon: "clock", tone: "ink-3" },
  starting: { label: "The Agent is starting", icon: "agent", tone: "ink-3" },
};

/**
 * Whose move it is and why, in the desktop's turn words. Turn membership and reason come from
 * Core; presentation never invents a completion state.
 */
export const entrySignature = (entry: InboxEntry): EntrySignature | null => {
  if (entry.rowKind === "answer") return { label: "Nodex · Answer", icon: "agent", tone: "ink-3" };
  if (entry.rowKind === "problem") return { label: "Problem", icon: "warning", tone: "danger" };
  if (entry.rowKind !== "turn") return null;
  return TURN_SIGNATURES[entry.turn.reason ?? "ready_to_start"];
};

export type MessageChat =
  | { readonly state: "starting" }
  | { readonly state: "failed" }
  | { readonly state: "open"; readonly sessionId: string };

/**
 * The chat a message started, as its delivery stands. A new chat opens only once its host has
 * started it, so the phone never shows a chat with nothing in it: until then the message itself
 * shows that it is starting, or why it could not start. A chat sent to already exists, and an
 * unconfirmed delivery may have reached it, so both can be opened to check.
 */
export const messageChat = (message: InboxEntry): MessageChat | null => {
  if (message.rowKind !== "intake") return null;
  const { proposal, chatSessionId } = message;
  if (proposal?.action.type === "new_chat" && proposal.failureKind !== "unknown") {
    if (proposal.state === "dispatching") return { state: "starting" };
    if (proposal.state === "failed") return { state: "failed" };
  }
  return chatSessionId ? { state: "open", sessionId: chatSessionId } : null;
};

/** Where tapping a row goes: work rows open their chat, where the conversation continues. */
export const entryChatSession = (entry: InboxEntry): string | null =>
  entry.rowKind === "turn"
    ? entry.turn.chatSessionId
    : entry.rowKind === "answer"
      ? entry.chatSessionId
      : null;

/** Reply entitlement is separate from durable Turn decisions such as Accept and Start. */
export const turnActionView = (entry: Extract<InboxEntry, { rowKind: "turn" }>) => {
  const { reason, options, chatSessionId, replyCapability } = entry.turn;
  const available = replyCapability.kind === "available";
  return {
    accept: reason === "review",
    start: reason === "ready_to_start",
    reviewRequest: available && reason === "approval" && chatSessionId !== null,
    reply:
      available && chatSessionId !== null && reason !== "approval" && reason !== "ready_to_start",
    options: available && reason === "question" ? options : [],
    unavailableReason: replyCapability.kind === "unavailable" ? replyCapability.reason : null,
  };
};
