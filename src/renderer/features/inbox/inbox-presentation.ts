import { CoreApiError } from "@/lib/core-api-error";
import type {
  InboxChat,
  InboxDispatchAction,
  InboxEntryKind,
  InboxFiring,
  InboxImportantMessage,
  InboxItem,
  InboxPageStatus,
  InboxProposal,
  InboxWindowFilter,
} from "../../../shared/inbox";
import type {
  InboxSuggestionPause,
  InboxSuggestionPolicy,
} from "../../../shared/inbox-suggestion-policy";
import type { CodexScheduledAutomation } from "../../../shared/types";
import { DEFAULT_WORKFLOW_STATUS } from "../../../shared/workflow-status";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import { USER_TURN_TIMESTAMP_GAP_MS } from "../local-conversation/projection/conversation-turn-timestamps";
import type { SessionLiveIndicator } from "@/lib/session-execution";
import { formatUsageCountdown } from "@/lib/usage-meter";

/** What the strip attached to a message in the Inbox shows: what Nodex made of it. */
export type InboxTriageModel =
  | { readonly kind: "suggesting" }
  | {
      readonly kind: "suggestion";
      readonly proposal: InboxProposal;
      /** New advice is on its way; this suggestion stays until it arrives. */
      readonly refreshing: boolean;
      /** Why asking again failed, while this suggestion stays. */
      readonly refreshError: string | null;
    }
  | { readonly kind: "suggestion-failed"; readonly message: string }
  | { readonly kind: "dispatch-failed"; readonly proposal: InboxProposal; readonly message: string }
  /** A scheduled task's waiting run whose task is gone, so it can no longer run. */
  | { readonly kind: "firing-withdrawn" }
  /** No advice has been asked for, or suggestions are off. */
  | { readonly kind: "undecided" }
  /** Handled; the message is on its way to History. */
  | { readonly kind: "handled" };

/** Starts a chat or sends to one, so it carries a prompt. */
export const isChatAction = (
  action: InboxDispatchAction,
): action is Extract<InboxDispatchAction, { type: "new_chat" | "send_to_chat" }> =>
  action.type === "new_chat" || action.type === "send_to_chat";

/** Hands the work on: to a chat, or to a run of the scheduled task the message came from. */
export const isWorkAction = (
  action: InboxDispatchAction,
): action is Extract<InboxDispatchAction, { type: "new_chat" | "send_to_chat" | "run_task" }> =>
  isChatAction(action) || action.type === "run_task";

/**
 * Mirrors Core's Inbox membership: a message is handled once its work is handed on, or once it
 * is filed, kept, or done. Where its Page lives never decides it. Failed or uncertain delivery,
 * and a scheduled run that failed before reaching a chat, remain in the Inbox for a decision.
 */
export function isInboxItemHandled(item: InboxItem): boolean {
  if (item.state !== "open") return true;
  const proposal = item.proposal;
  return Boolean(
    proposal &&
    isWorkAction(proposal.action) &&
    proposal.failureKind !== "unknown" &&
    item.firing?.status !== "failed" &&
    (proposal.state === "dispatching" || proposal.state === "completed"),
  );
}

export function inboxTriageModel(item: InboxItem, policy: InboxSuggestionPolicy): InboxTriageModel {
  const proposal = item.proposal;
  if (
    proposal &&
    isWorkAction(proposal.action) &&
    (proposal.state === "failed" ||
      (proposal.action.type === "run_task" && item.firing?.status === "failed") ||
      (proposal.state === "dispatching" && proposal.failureKind === "unknown"))
  ) {
    return {
      kind: "dispatch-failed",
      proposal,
      message:
        proposal.failureMessage ??
        item.firing?.failureMessage ??
        (proposal.action.type === "run_task"
          ? "The run could not be started"
          : "The chat could not be started"),
    };
  }
  if (isInboxItemHandled(item)) return { kind: "handled" };
  if (item.firing?.status === "withdrawn") return { kind: "firing-withdrawn" };
  // A message waiting for automatic advice gets it only while suggestions run on their own;
  // otherwise Main releases it and it simply has none.
  const advising =
    policy.kind !== "off" &&
    (item.suggestionState === "pending" ||
      (item.suggestionState === "waiting" && policy.kind === "automatic"));
  const failure =
    item.suggestionState === "failed"
      ? (item.suggestionError ?? "No suggestion was produced")
      : null;
  if (proposal?.state === "open")
    return { kind: "suggestion", proposal, refreshing: advising, refreshError: failure };
  if (advising) return { kind: "suggesting" };
  if (failure !== null) return { kind: "suggestion-failed", message: failure };
  return { kind: "undecided" };
}

/** Which of the message menu's actions a message's action row already shows. */
export interface InboxRowOffers {
  readonly done: boolean;
  readonly handleManually: boolean;
  readonly suggest: boolean;
}

export const NO_ROW_OFFERS: InboxRowOffers = { done: false, handleManually: false, suggest: false };

/**
 * What a message's action row offers beside its menu, so the menu holds only the rest and no
 * action appears twice. A group member whose suggestion shows on another message offers nothing
 * but its menu.
 */
export function inboxRowOffers(
  model: InboxTriageModel,
  input: { readonly suggestionsOffered: boolean; readonly grouped: boolean },
): InboxRowOffers {
  if (input.grouped && model.kind === "suggestion") return NO_ROW_OFFERS;
  switch (model.kind) {
    case "suggesting":
    case "dispatch-failed":
      return { done: true, handleManually: true, suggest: false };
    case "firing-withdrawn":
      return { done: true, handleManually: true, suggest: false };
    case "suggestion":
      // Changing a suggestion happens in `Handle manually`, which stays in the menu. An outdated
      // or failed one asks again from the row, where new advice then shows its spinner.
      return {
        done: true,
        handleManually: false,
        suggest:
          model.refreshing ||
          (input.suggestionsOffered && (model.proposal.outdated || model.refreshError !== null)),
      };
    case "suggestion-failed":
    case "undecided":
      return { done: true, handleManually: true, suggest: input.suggestionsOffered };
    case "handled":
      return NO_ROW_OFFERS;
  }
}

/** One quiet indicator is enough: only the newest message still waiting for advice shows it. */
export function inboxAwaitingIndicatorPageId(
  items: readonly InboxItem[],
  policy: InboxSuggestionPolicy,
): string | null {
  return (
    items.findLast((item) => inboxTriageModel(item, policy).kind === "suggesting")?.pageId ?? null
  );
}

/**
 * Which usage ran short, in a few words: how much is left, or that it is used up, and when it
 * comes back.
 */
export function describeInboxSuggestionPause(pause: InboxSuggestionPause, nowMs: number): string {
  const left = pause.pace === "spent" ? "used up" : `${pause.leftPercent}% left`;
  const resetsAt = pause.resetsAt ? Date.parse(pause.resetsAt) : Number.NaN;
  const state = `${pause.agent} ${pause.window}: ${left}`;
  return Number.isFinite(resetsAt)
    ? `${state}, resets ${formatUsageCountdown(resetsAt, nowMs)}`
    : state;
}

/** Where a message's Page is read from now: its filed Database's Project, else its Inbox's. */
export function inboxPageRoutingContext(item: InboxItem): ContentRoutingContext {
  if (item.location.kind === "database") {
    return item.location.projectId
      ? { kind: "project", projectId: item.location.projectId }
      : { kind: "library" };
  }
  return item.scope;
}

/** The kind the user set, else the one the current suggestion proposes. */
export const inboxEntryKind = (item: InboxItem): InboxEntryKind | null =>
  item.kind ?? item.proposal?.kind ?? null;

/**
 * The Board status a message shows beside it. Every message waits in Triage, so only a Page that
 * has moved on says anything: its work has already started somewhere else.
 */
export const inboxPageStatusMark = (item: InboxItem): InboxPageStatus | null =>
  item.pageStatus && item.pageStatus.id !== DEFAULT_WORKFLOW_STATUS ? item.pageStatus : null;

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
  /**
   * Whether the user has closed the chat's work, which a finished chat never does for them;
   * null for messages not handed to a chat.
   */
  readonly done: boolean | null;
  /** Work still under way: being delivered, or its chat working, waiting, or with a new reply. */
  readonly inProgress: boolean;
}

const keptLabel = (kind: InboxEntryKind | null) =>
  kind ? `Kept as ${INBOX_KIND_LABELS[kind].toLowerCase()}` : "Kept";

const KEPT = { icon: "keep", status: null, open: null, canReturn: true, done: null } as const;
const DONE = { icon: "done", label: "Done", status: null, open: null, canReturn: true } as const;
const SKIPPED = { ...DONE, label: "Skipped" } as const;

/** The task a scheduled run came from, as the message names it. */
const firingTaskName = (item: InboxItem): string =>
  item.source.kind === "scheduled_task" ? item.source.label : "scheduled task";

const chatLabel = (
  type: "new_chat" | "send_to_chat",
  delivered: boolean,
  title: string,
  projectName: string | null,
) => {
  if (type === "send_to_chat") return delivered ? `Sent to “${title}”` : `Sending to “${title}”`;
  return delivered ? `Started “${title}”` : `Starting a chat in ${projectName ?? "no Project"}`;
};

const DONE_STATUS: InboxChatStatusPresentation = {
  label: "Done",
  tone: "quiet",
  inProgress: false,
};

/** `live` is the receiving chat's Runtime activity, when the chat is Runtime-bound. */
export function describeInboxOutcome(
  item: InboxItem,
  live: SessionLiveIndicator | null = null,
): InboxOutcome {
  if (item.outcome === "kept") {
    return { ...KEPT, label: keptLabel(item.kind), inProgress: false };
  }
  if (item.outcome === "done") {
    return {
      ...(item.firing?.status === "skipped" ? SKIPPED : DONE),
      done: null,
      inProgress: false,
    };
  }
  const proposal = item.proposal;
  if (
    proposal?.action.type === "run_task" &&
    (item.outcome === "chat" || proposal.state === "completed")
  ) {
    const chat = proposal.chat;
    const done = item.state === "done";
    const title = `“${firingTaskName(item)}”`;
    // A Cron run reaches a chat once its workspace is ready; a Heartbeat already has its chat.
    if (!chat) {
      return {
        icon: done ? "done" : "pending",
        label: `Starting ${title}`,
        status: done ? DONE_STATUS : null,
        open: null,
        canReturn: false,
        done,
        inProgress: !done,
      };
    }
    const status = done ? DONE_STATUS : describeInboxChatStatus(chat, live);
    return {
      icon: "chat",
      label: `Ran ${title}`,
      status,
      open: { kind: "session", sessionId: chat.sessionId },
      canReturn: false,
      done,
      inProgress: status.inProgress,
    };
  }
  if (
    proposal &&
    isChatAction(proposal.action) &&
    (item.outcome === "chat" ||
      (proposal.state === "dispatching" && proposal.failureKind !== "unknown"))
  ) {
    const chat = proposal.chat;
    const open: InboxOutcomeTarget | null = chat
      ? { kind: "session", sessionId: chat.sessionId }
      : null;
    const done = item.state === "done";
    const label = chatLabel(
      proposal.action.type,
      proposal.state === "completed",
      chat?.displayTitle ?? "chat",
      proposal.targetProjectName,
    );
    if (proposal.state === "dispatching") {
      return {
        icon: "pending",
        label,
        status: done ? DONE_STATUS : null,
        open,
        canReturn: false,
        done,
        inProgress: !done,
      };
    }
    if (proposal.state === "completed") {
      const status = done ? DONE_STATUS : describeInboxChatStatus(chat, live);
      return {
        icon: "chat",
        label,
        status,
        open,
        canReturn: false,
        done,
        inProgress: status.inProgress,
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
      done: null,
      inProgress: false,
    };
  }
  return {
    icon: "inbox",
    label: "In the Inbox",
    status: null,
    open: null,
    canReturn: false,
    done: null,
    inProgress: false,
  };
}

/** A decision this window just made, described before Core's handled message arrives. */
export type InboxDecision =
  | { readonly kind: "keep" }
  | { readonly kind: "done" }
  /** A scheduled task's waiting run, confirmed to run now. */
  | { readonly kind: "run"; readonly taskName: string }
  | { readonly kind: "move"; readonly projectName: string | null }
  | {
      readonly kind: "chat";
      readonly type: "new_chat" | "send_to_chat";
      readonly sessionId: string;
      /** The receiving chat's title, when it already has one. */
      readonly chatTitle: string | null;
      readonly projectName: string | null;
    };

/** What a message shows in its place in the Inbox between the decision and folding away. */
export function describeInboxDecision(item: InboxItem, decision: InboxDecision): InboxOutcome {
  switch (decision.kind) {
    case "keep":
      return { ...KEPT, label: keptLabel(inboxEntryKind(item)), inProgress: false };
    case "done":
      return { ...(item.firing ? SKIPPED : DONE), done: null, inProgress: false };
    case "run":
      return {
        icon: "pending",
        label: `Starting “${decision.taskName}”`,
        status: null,
        open: null,
        canReturn: false,
        done: false,
        inProgress: true,
      };
    case "move":
      return {
        icon: "move",
        label: `Moved to ${decision.projectName ?? "Project"}`,
        status: null,
        open: null,
        canReturn: false,
        done: null,
        inProgress: false,
      };
    case "chat":
      return {
        icon: "pending",
        label: chatLabel(decision.type, false, decision.chatTitle ?? "chat", decision.projectName),
        status: null,
        open: { kind: "session", sessionId: decision.sessionId },
        canReturn: false,
        done: false,
        inProgress: true,
      };
  }
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
    case "run_task":
      return {
        verb: "Run",
        // A Heartbeat continues its chat; a Cron run starts in its Project or on its own.
        target: context.chat
          ? `Run in “${context.chat.displayTitle}”`
          : context.targetProjectName
            ? `Run in ${context.targetProjectName}`
            : "Run without a Project",
      };
  }
}

const formatFiringTime = (at: number, now: Date): string => {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = startOfDay(date).getTime();
  if (day === startOfDay(now).getTime()) return time;
  return `${inboxDayLabel(date, now)}, ${time}`;
};

/**
 * How a scheduled task's waiting run will go, in one quiet line beneath its instructions: when it
 * fell due, how often it has since, and where it runs. Its instructions are the message itself.
 */
export function describeInboxFiring(
  firing: InboxFiring,
  task: Pick<
    CodexScheduledAutomation,
    "kind" | "projectId" | "executionEnvironment" | "cwds"
  > | null,
  now: Date,
): string {
  const dueCount = firing.missedCount + 1;
  const due =
    dueCount > 1
      ? `Due ${dueCount} times since ${formatFiringTime(firing.firstScheduledFor, now)}`
      : `Due ${formatFiringTime(firing.firstScheduledFor, now)}`;
  if (!task) return due;
  const where =
    task.kind === "heartbeat"
      ? "Continues its chat"
      : task.projectId === null
        ? "New workspace"
        : [
            task.executionEnvironment === "worktree" ? "Worktree" : "Local",
            task.cwds.length > 1 ? `${task.cwds.length} folders` : null,
          ]
            .filter(Boolean)
            .join(" · ");
  return `${due} · ${where}`;
}

export type InboxChatTone = "working" | "attention" | "error" | "quiet";

export interface InboxChatStatusPresentation {
  readonly label: string;
  readonly tone: InboxChatTone;
  /** The chat is still working, waiting on the user, or holds a reply they have not read. */
  readonly inProgress: boolean;
}

/**
 * A Runtime-bound chat reports its live Session activity (`live`); a native chat reports its
 * Core Thread status. A reply the user has not read keeps either in progress.
 */
export function describeInboxChatStatus(
  chat: InboxChat | null,
  live: SessionLiveIndicator | null = null,
): InboxChatStatusPresentation {
  if (!chat) return { label: "Chat unavailable", tone: "error", inProgress: false };
  if (chat.archived) return { label: "Archived", tone: "quiet", inProgress: false };
  if (chat.executionRef) {
    if (live === "waiting") return { label: "Needs input", tone: "attention", inProgress: true };
    if (live) return { label: "Working", tone: "working", inProgress: true };
  } else {
    const status = chat.status;
    if (!status) return { label: "Starting", tone: "working", inProgress: true };
    if (status.activeFlags.includes("waitingOnUserInput")) {
      return { label: "Needs input", tone: "attention", inProgress: true };
    }
    if (status.activeFlags.includes("waitingOnApproval")) {
      return { label: "Waiting", tone: "working", inProgress: true };
    }
    if (status.statusType === "active") {
      return { label: "Working", tone: "working", inProgress: true };
    }
    if (status.statusType === "systemError") {
      return { label: "Error", tone: "error", inProgress: true };
    }
  }
  return chat.unread
    ? { label: "New reply", tone: "attention", inProgress: true }
    : { label: "Idle", tone: "quiet", inProgress: false };
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

/** The important message the stream points back to, with where it stands among them. */
export interface InboxBuriedImportant {
  readonly message: InboxImportantMessage;
  /** Its place among the Inbox's important messages, oldest first, counting from 1. */
  readonly position: number;
  readonly total: number;
}

/**
 * The longest-waiting important message out of view, or null when every one is in view. What
 * waits longest is what is easiest to let slip, so it is the one worth pointing back to.
 */
export function inboxBuriedImportant(
  important: readonly InboxImportantMessage[],
  total: number,
  inView: (pageId: string) => boolean,
): InboxBuriedImportant | null {
  const index = important.findIndex((message) => !inView(message.pageId));
  const message = important[index];
  return message ? { message, position: index + 1, total } : null;
}

/** A message's time when it was sent today, else its day. */
export function formatInboxWhen(submittedAt: string, now: Date): string {
  const date = new Date(submittedAt);
  return startOfDay(date).getTime() === startOfDay(now).getTime()
    ? formatInboxTime(submittedAt)
    : inboxDayLabel(date, now);
}
