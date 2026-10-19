import { CoreApiError } from "@/lib/core-api-error";
import type {
  InboxChat,
  InboxDispatchAction,
  InboxEntryKind,
  InboxItem,
  InboxProposal,
  InboxWindowFilter,
} from "../../../shared/inbox";
import { USER_TURN_TIMESTAMP_GAP_MS } from "../local-conversation/projection/conversation-turn-timestamps";

/** What the strip attached to a message in the Inbox shows: what Nodex made of it. */
export type InboxTriageModel =
  | { readonly kind: "suggesting" }
  | { readonly kind: "suggestion"; readonly proposal: InboxProposal }
  | { readonly kind: "suggestion-failed"; readonly message: string }
  | { readonly kind: "dispatch-failed"; readonly proposal: InboxProposal; readonly message: string }
  /** No advice has arrived, or suggestions are disabled. */
  | { readonly kind: "undecided" }
  /** Handled; the message is on its way to History. */
  | { readonly kind: "handled" };

const isChatAction = (action: InboxDispatchAction) =>
  action.type === "new_chat" || action.type === "send_to_chat";

/**
 * Mirrors Core's Inbox membership: a message is handled once a chat dispatch is confirmed, or
 * once it is filed, kept, or done. Where its Page lives never decides it. Failed or
 * uncertain delivery remains in the Inbox for a reviewed decision.
 */
export function isInboxItemHandled(item: InboxItem): boolean {
  if (item.state !== "open") return true;
  const proposal = item.proposal;
  return Boolean(
    proposal &&
    isChatAction(proposal.action) &&
    proposal.failureKind !== "unknown" &&
    (proposal.state === "dispatching" || proposal.state === "completed"),
  );
}

export function inboxTriageModel(item: InboxItem, suggestionsEnabled: boolean): InboxTriageModel {
  const proposal = item.proposal;
  if (
    proposal &&
    isChatAction(proposal.action) &&
    (proposal.state === "failed" ||
      (proposal.state === "dispatching" && proposal.failureKind === "unknown"))
  ) {
    return {
      kind: "dispatch-failed",
      proposal,
      message: proposal.failureMessage ?? "The chat could not be started",
    };
  }
  if (isInboxItemHandled(item)) return { kind: "handled" };
  if (proposal?.state === "open") return { kind: "suggestion", proposal };
  if (item.suggestionState === "pending" && suggestionsEnabled) return { kind: "suggesting" };
  if (item.suggestionState === "failed") {
    return {
      kind: "suggestion-failed",
      message: item.suggestionError ?? "No suggestion was produced",
    };
  }
  return { kind: "undecided" };
}

/** One quiet indicator is enough: only the newest message still waiting for advice shows it. */
export function inboxAwaitingIndicatorPageId(
  items: readonly InboxItem[],
  suggestionsEnabled: boolean,
): string | null {
  return (
    items.findLast((item) => inboxTriageModel(item, suggestionsEnabled).kind === "suggesting")
      ?.pageId ?? null
  );
}

export type InboxOutcomeIcon = "chat" | "pending" | "move" | "keep" | "done" | "inbox";

export type InboxOutcomeTarget =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "database"; readonly databaseId: string };

/** How a handled message was handled, as one History line. */
export interface InboxOutcome {
  readonly icon: InboxOutcomeIcon;
  readonly label: string;
  /** Live state of the chat that received it. */
  readonly status: InboxChatStatusPresentation | null;
  readonly open: InboxOutcomeTarget | null;
  /** Kept and done messages can go back to the Inbox; dispatched work cannot be recalled. */
  readonly canReturn: boolean;
}

export function describeInboxOutcome(item: InboxItem): InboxOutcome {
  if (item.outcome === "kept") {
    return {
      icon: "keep",
      label: item.kind ? `Kept as ${INBOX_KIND_LABELS[item.kind].toLowerCase()}` : "Kept",
      status: null,
      open: null,
      canReturn: true,
    };
  }
  if (item.outcome === "done") {
    return { icon: "done", label: "Done", status: null, open: null, canReturn: true };
  }
  const proposal = item.proposal;
  if (
    proposal &&
    isChatAction(proposal.action) &&
    (item.outcome === "chat" ||
      (proposal.state === "dispatching" && proposal.failureKind !== "unknown"))
  ) {
    const chat = proposal.chat;
    const title = chat?.displayTitle ?? "chat";
    const open: InboxOutcomeTarget | null = chat
      ? { kind: "session", sessionId: chat.sessionId }
      : null;
    if (proposal.state === "dispatching") {
      return {
        icon: "pending",
        label:
          proposal.action.type === "send_to_chat"
            ? `Sending to “${title}”`
            : `Starting a chat in ${proposal.targetProjectName ?? "no Project"}`,
        status: null,
        open,
        canReturn: false,
      };
    }
    if (proposal.state === "completed") {
      return {
        icon: "chat",
        label:
          proposal.action.type === "send_to_chat" ? `Sent to “${title}”` : `Started “${title}”`,
        status: describeInboxChatStatus(chat),
        open,
        canReturn: false,
      };
    }
  }
  if (item.outcome === "moved") {
    return {
      icon: "move",
      label: `Moved to ${proposal?.targetProjectName ?? (item.location.kind === "database" ? item.location.projectName : null) ?? "Project"}`,
      status: null,
      open:
        item.location.kind === "database"
          ? { kind: "database", databaseId: item.location.databaseId }
          : null,
      canReturn: false,
    };
  }
  return { icon: "inbox", label: "In the Inbox", status: null, open: null, canReturn: false };
}

export interface InboxActionPresentation {
  /** The confirming button's verb. */
  readonly verb: string;
  /** Where the work goes, in one short phrase. */
  readonly target: string;
}

export function describeInboxAction(
  action: InboxDispatchAction,
  context: {
    readonly targetProjectName: string | null;
    readonly chat: InboxChat | null;
  },
): InboxActionPresentation {
  switch (action.type) {
    case "keep":
      return { verb: "Keep", target: "Keep" };
    case "new_chat":
      return {
        verb: "Start chat",
        target: action.projectId
          ? `New chat in ${context.targetProjectName ?? "Project"}`
          : "New projectless chat",
      };
    case "send_to_chat": {
      const title = context.chat?.displayTitle ?? "chat";
      return {
        verb: context.chat?.status?.statusType === "active" ? "Queue" : "Send",
        target:
          context.chat?.status?.statusType === "active"
            ? `Send to “${title}” after it finishes`
            : `Send to “${title}”`,
      };
    }
    case "move_to_project":
      return { verb: "Move", target: `Move to ${context.targetProjectName ?? "Project"}` };
  }
}

export type InboxChatTone = "working" | "attention" | "error" | "quiet";

export interface InboxChatStatusPresentation {
  readonly label: string;
  readonly tone: InboxChatTone;
}

export function describeInboxChatStatus(chat: InboxChat | null): InboxChatStatusPresentation {
  if (!chat) return { label: "Chat unavailable", tone: "error" };
  if (chat.archived) return { label: "Archived", tone: "quiet" };
  const status = chat.status;
  if (!status) return { label: "Starting", tone: "working" };
  if (status.activeFlags.includes("waitingOnUserInput")) {
    return { label: "Needs input", tone: "attention" };
  }
  if (status.activeFlags.includes("waitingOnApproval")) {
    return { label: "Waiting", tone: "working" };
  }
  if (status.statusType === "active") return { label: "Working", tone: "working" };
  if (status.statusType === "systemError") return { label: "Error", tone: "error" };
  return chat.unread ? { label: "New reply", tone: "attention" } : { label: "Idle", tone: "quiet" };
}

export const INBOX_KIND_LABELS: Readonly<Record<InboxEntryKind, string>> = {
  note: "Note",
  todo: "Todo",
  question: "Question",
};

export const INBOX_VIEW_LABELS: Readonly<Record<InboxWindowFilter, string>> = {
  inbox: "Inbox",
  processed: "History",
};

export interface InboxDaySection {
  readonly key: string;
  readonly label: string;
  readonly items: readonly InboxItem[];
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

export function inboxDayLabel(date: Date, now: Date): string {
  const days = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Groups ordered items into local-day sections, keeping the given order. */
export function groupInboxItemsByDay(
  items: readonly InboxItem[],
  now: Date,
): readonly InboxDaySection[] {
  const sections: { key: string; label: string; items: InboxItem[] }[] = [];
  for (const item of items) {
    const date = new Date(item.submittedAt);
    const key = startOfDay(date).toISOString();
    const current = sections.at(-1);
    if (current?.key === key) {
      current.items.push(item);
    } else {
      sections.push({ key, label: inboxDayLabel(date, now), items: [item] });
    }
  }
  return sections;
}

/** Expired proof cannot tell us whether the earlier command was committed. */
export const inboxReceiptNeedsReview = (error: unknown): boolean =>
  error instanceof CoreApiError &&
  (error.code === "idempotency_window_expired" || error.code === "legacy_idempotency_unavailable");

const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/;

/** Electron prefixes rejected IPC calls; the Core reason after it is the useful part. */
export function readableInboxError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const readable = message.replace(REMOTE_METHOD_PREFIX, "").trim();
  return readable || fallback;
}

/**
 * Where the oldest-first Inbox stream shows a centered time, as a conversation does: above
 * the first message once it is over an hour old, and above any message sent over an hour
 * after the one before it. Each message's own time waits for a hover.
 */
export function inboxTimestampSeparators(
  items: readonly InboxItem[],
  nowMs: number,
): Array<number | null> {
  return items.map((item, index) => {
    const sentAtMs = Date.parse(item.submittedAt);
    if (!Number.isFinite(sentAtMs)) return null;
    const previous = items[index - 1];
    const sinceMs = previous ? sentAtMs - Date.parse(previous.submittedAt) : nowMs - sentAtMs;
    return sinceMs > USER_TURN_TIMESTAMP_GAP_MS ? sentAtMs : null;
  });
}

export const formatInboxTime = (submittedAt: string): string =>
  new Date(submittedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
