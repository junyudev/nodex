import type { PageChatActivitySummary, PageChatItem } from "./types";
import type { SessionLiveIndicator } from "./session-execution";

export type PageChatExecutionIndicator =
  | "error"
  | "approval"
  | "input"
  | "working"
  | "background"
  | "idle";

export interface PageChatActivityPresentation {
  readonly execution: PageChatExecutionIndicator;
  readonly unread: boolean;
  readonly accessibleLabel: string;
}

/** Live status of Runtime-bound Sessions keyed by Session; idle Sessions are absent. */
export type PageChatRuntimeStatuses = ReadonlyMap<string, SessionLiveIndicator>;

const NO_RUNTIME_STATUSES: PageChatRuntimeStatuses = new Map();

const counted = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

/**
 * Core counts native thread status; Runtime-bound Sessions add their live Session activity. A
 * waiting Runtime chat awaits the user's information, so it counts as awaiting input.
 */
export function presentPageChatActivity(
  summary: PageChatActivitySummary,
  runtimeStatuses: PageChatRuntimeStatuses = NO_RUNTIME_STATUSES,
): PageChatActivityPresentation {
  let workingCount = summary.workingCount;
  let waitingOnUserInputCount = summary.waitingOnUserInputCount;
  let backgroundCount = 0;
  for (const sessionId of summary.runtimeSessionIds) {
    const status = runtimeStatuses.get(sessionId);
    if (status === "running") workingCount += 1;
    else if (status === "waiting") waitingOnUserInputCount += 1;
    else if (status === "background") backgroundCount += 1;
  }
  const execution: PageChatExecutionIndicator =
    summary.errorCount > 0
      ? "error"
      : summary.waitingOnApprovalCount > 0
        ? "approval"
        : waitingOnUserInputCount > 0
          ? "input"
          : workingCount > 0
            ? "working"
            : backgroundCount > 0
              ? "background"
              : "idle";
  const parts = [counted(summary.relatedCount, "linked chat")];
  if (summary.errorCount > 0) parts.push(counted(summary.errorCount, "error"));
  if (summary.waitingOnApprovalCount > 0) {
    parts.push(counted(summary.waitingOnApprovalCount, "awaiting approval"));
  }
  if (waitingOnUserInputCount > 0) {
    parts.push(counted(waitingOnUserInputCount, "awaiting input"));
  }
  if (workingCount > 0) parts.push(counted(workingCount, "working chat"));
  if (backgroundCount > 0) {
    parts.push(counted(backgroundCount, "chat working in background", "chats working in background"));
  }
  if (summary.unreadCount > 0) parts.push(counted(summary.unreadCount, "unread chat"));
  const unread = summary.unreadCount > 0;
  return {
    execution,
    unread,
    accessibleLabel: parts.join(", "),
  };
}

/** A Runtime-bound row reads its live activity; a native row reads its Core thread status. */
export function presentPageChatItemActivity(
  item: PageChatItem,
  runtimeStatus: SessionLiveIndicator | null = null,
): PageChatActivityPresentation {
  const inactive = item.threadArchived || item.sessionArchived;
  const status = inactive || item.executionRef ? null : item.threadStatus;
  return presentPageChatActivity(
    {
      pageId: "",
      relatedCount: 1,
      workingCount: status?.statusType === "active" && status.activeFlags.length === 0 ? 1 : 0,
      waitingOnApprovalCount: status?.activeFlags.includes("waitingOnApproval") ? 1 : 0,
      waitingOnUserInputCount: status?.activeFlags.includes("waitingOnUserInput") ? 1 : 0,
      errorCount: status?.statusType === "systemError" ? 1 : 0,
      unreadCount: item.unread ? 1 : 0,
      soleSessionId: item.sessionId,
      runtimeSessionIds: item.executionRef && !inactive ? [item.sessionId] : [],
    },
    runtimeStatus ? new Map([[item.sessionId, runtimeStatus]]) : NO_RUNTIME_STATUSES,
  );
}
