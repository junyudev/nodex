import { getIntl } from "@/lib/i18n";
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

/**
 * Core counts native thread status; Runtime-bound Sessions add their live Session activity. A
 * waiting Runtime chat retains whether it needs approval or information.
 */
export function presentPageChatActivity(
  summary: PageChatActivitySummary,
  runtimeStatuses: PageChatRuntimeStatuses = NO_RUNTIME_STATUSES,
): PageChatActivityPresentation {
  let workingCount = summary.workingCount;
  let waitingOnApprovalCount = summary.waitingOnApprovalCount;
  let waitingOnUserInputCount = summary.waitingOnUserInputCount;
  let backgroundCount = 0;
  for (const sessionId of summary.runtimeSessionIds) {
    const status = runtimeStatuses.get(sessionId);
    if (status === "running") workingCount += 1;
    else if (status === "approval") waitingOnApprovalCount += 1;
    else if (status === "waiting") waitingOnUserInputCount += 1;
    else if (status === "background") backgroundCount += 1;
  }
  const execution: PageChatExecutionIndicator =
    summary.errorCount > 0
      ? "error"
      : waitingOnApprovalCount > 0
        ? "approval"
        : waitingOnUserInputCount > 0
          ? "input"
          : workingCount > 0
            ? "working"
            : backgroundCount > 0
              ? "background"
              : "idle";
  const parts = [
    getIntl().formatMessage(
      {
        id: "lib.pageChatActivityPresentation.linked",
        defaultMessage: "{count, plural, one {# linked chat} other {# linked chats}}",
      },
      { count: summary.relatedCount },
    ),
  ];
  if (summary.errorCount > 0)
    parts.push(
      getIntl().formatMessage(
        {
          id: "lib.pageChatActivityPresentation.error",
          defaultMessage: "{count, plural, one {# error} other {# errors}}",
        },
        { count: summary.errorCount },
      ),
    );
  if (waitingOnApprovalCount > 0) {
    parts.push(
      getIntl().formatMessage(
        {
          id: "lib.pageChatActivityPresentation.approval",
          defaultMessage: "{count, plural, one {# awaiting approval} other {# awaiting approvals}}",
        },
        { count: waitingOnApprovalCount },
      ),
    );
  }
  if (waitingOnUserInputCount > 0) {
    parts.push(
      getIntl().formatMessage(
        {
          id: "lib.pageChatActivityPresentation.input",
          defaultMessage: "{count, plural, one {# awaiting input} other {# awaiting inputs}}",
        },
        { count: waitingOnUserInputCount },
      ),
    );
  }
  if (workingCount > 0)
    parts.push(
      getIntl().formatMessage(
        {
          id: "lib.pageChatActivityPresentation.working",
          defaultMessage: "{count, plural, one {# working chat} other {# working chats}}",
        },
        { count: workingCount },
      ),
    );
  if (backgroundCount > 0) {
    parts.push(
      getIntl().formatMessage(
        {
          id: "lib.pageChatActivityPresentation.background",
          defaultMessage:
            "{count, plural, one {# chat working in background} other {# chats working in background}}",
        },
        { count: backgroundCount },
      ),
    );
  }
  if (summary.unreadCount > 0)
    parts.push(
      getIntl().formatMessage(
        {
          id: "lib.pageChatActivityPresentation.unread",
          defaultMessage: "{count, plural, one {# unread chat} other {# unread chats}}",
        },
        { count: summary.unreadCount },
      ),
    );
  const unread = summary.unreadCount > 0;
  return {
    execution,
    unread,
    accessibleLabel: getIntl().formatList(parts, { type: "unit", style: "short" }),
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
      work: { activeChat: null, latestReport: null, managedSessionCount: 0 },
      runtimeSessionIds: item.executionRef && !inactive ? [item.sessionId] : [],
    },
    runtimeStatus ? new Map([[item.sessionId, runtimeStatus]]) : NO_RUNTIME_STATUSES,
  );
}
