import type { PageChatActivitySummary, PageChatItem } from "./types";

export type PageChatExecutionIndicator = "error" | "approval" | "input" | "working" | "idle";

export interface PageChatActivityPresentation {
  readonly execution: PageChatExecutionIndicator;
  readonly unread: boolean;
  readonly accessibleLabel: string;
}

const counted = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

export function presentPageChatActivity(
  summary: PageChatActivitySummary,
): PageChatActivityPresentation {
  const execution: PageChatExecutionIndicator =
    summary.errorCount > 0
      ? "error"
      : summary.waitingOnApprovalCount > 0
        ? "approval"
        : summary.waitingOnUserInputCount > 0
          ? "input"
          : summary.workingCount > 0
            ? "working"
            : "idle";
  const parts = [counted(summary.relatedCount, "linked chat")];
  if (summary.errorCount > 0) parts.push(counted(summary.errorCount, "error"));
  if (summary.waitingOnApprovalCount > 0) {
    parts.push(counted(summary.waitingOnApprovalCount, "awaiting approval"));
  }
  if (summary.waitingOnUserInputCount > 0) {
    parts.push(counted(summary.waitingOnUserInputCount, "awaiting input"));
  }
  if (summary.workingCount > 0) parts.push(counted(summary.workingCount, "working chat"));
  if (summary.unreadCount > 0) parts.push(counted(summary.unreadCount, "unread chat"));
  const unread = summary.unreadCount > 0;
  return {
    execution,
    unread,
    accessibleLabel: parts.join(", "),
  };
}

export function presentPageChatItemActivity(item: PageChatItem): PageChatActivityPresentation {
  const status = item.threadArchived || item.sessionArchived ? null : item.threadStatus;
  return presentPageChatActivity({
    pageId: "",
    relatedCount: 1,
    workingCount: status?.statusType === "active" && status.activeFlags.length === 0 ? 1 : 0,
    waitingOnApprovalCount: status?.activeFlags.includes("waitingOnApproval") ? 1 : 0,
    waitingOnUserInputCount: status?.activeFlags.includes("waitingOnUserInput") ? 1 : 0,
    errorCount: status?.statusType === "systemError" ? 1 : 0,
    unreadCount: item.unread ? 1 : 0,
    soleSessionId: item.sessionId,
  });
}
