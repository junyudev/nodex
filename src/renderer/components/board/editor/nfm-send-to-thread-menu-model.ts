import type { CodexThreadSummary, PageChatItem } from "@/lib/types";
import { CURRENT_CHAT_LABEL, type ChatDestinationTarget } from "@/lib/page-chat-actions";
import { normalizeSearchText } from "@/lib/search-text";
import type { ChatActivity, ChatSearchMatch } from "../../../../shared/chat-search";
import { formatThreadMentionShortUuid } from "@/lib/editor-model/thread-mention-display";
import { resolveCodexElectronDisplayThreadTitle } from "../../../../shared/codex-thread-title";

export type NfmSendToThreadTarget = ChatDestinationTarget;

export interface NfmSendToThreadRequest {
  target: NfmSendToThreadTarget;
}

export type NfmSendToThreadPreferredTarget =
  | { kind: "thread"; thread: CodexThreadSummary; sessionId: string; meta: string }
  | { kind: "new-thread"; sessionId: string; meta: typeof CURRENT_CHAT_LABEL; label?: string };

export interface NfmSendToThreadNewRow {
  kind: "new-thread";
  id: string;
  label: string;
  meta: string;
  isFooterAction: boolean;
  isPreferredTarget: boolean;
  target: Extract<NfmSendToThreadTarget, { kind: "new-thread" }>;
}

export interface NfmSendToThreadExistingRow {
  kind: "thread";
  id: string;
  threadId: string;
  label: string;
  meta: string;
  isPreferredTarget: boolean;
  match: ChatSearchMatch;
  target: Extract<NfmSendToThreadTarget, { kind: "thread" }>;
}

export type NfmSendToThreadRow = NfmSendToThreadNewRow | NfmSendToThreadExistingRow;

export interface NfmSendToThreadRowsInput {
  /** Started chats matching `query`, best first. */
  matches: readonly ChatSearchMatch[];
  /** Chats linked to the source Page, listed after the preferred chat while not searching. */
  linkedChats?: readonly ChatSearchMatch[];
  query: string;
  preferredTarget?: NfmSendToThreadPreferredTarget | null;
  projectNameById?: Readonly<Record<string, string>>;
}

/**
 * The chat whose Scene a picker opened in, listed first: its live Thread, or a first Turn in
 * it when it has none yet and may start one here.
 */
export function resolveNfmSendToThreadPreferredTarget({
  sessionId,
  sessionThread,
  canStartThreadInSession,
  sessionTitle,
}: {
  readonly sessionId: string | null | undefined;
  readonly sessionThread: CodexThreadSummary | null | undefined;
  readonly canStartThreadInSession: boolean;
  /** Names a chat without a Thread, which has no Thread title to show. */
  readonly sessionTitle?: string | null;
}): NfmSendToThreadPreferredTarget | null {
  const normalizedSessionId = sessionId?.trim();
  if (!normalizedSessionId) return null;
  if (isAvailablePreferredThread(sessionThread)) {
    return {
      kind: "thread",
      thread: sessionThread,
      sessionId: normalizedSessionId,
      meta: CURRENT_CHAT_LABEL,
    };
  }
  return canStartThreadInSession
    ? {
        kind: "new-thread",
        sessionId: normalizedSessionId,
        meta: CURRENT_CHAT_LABEL,
        ...(sessionTitle?.trim() ? { label: sessionTitle.trim() } : {}),
      }
    : null;
}

/** Where a contextual send goes: the chat's live Thread, or a first Turn in its Session. */
export function resolveNfmSendToThreadPreferredDestination(
  preferredTarget: NfmSendToThreadPreferredTarget,
): NfmSendToThreadTarget {
  return preferredTarget.kind === "thread"
    ? {
        kind: "thread",
        threadId: preferredTarget.thread.threadId,
        sessionId: preferredTarget.sessionId,
      }
    : { kind: "new-thread", sessionId: preferredTarget.sessionId };
}

/** The contextual chat's own title, for tooltips and confirmations. */
export function describeNfmSendToThreadPreferredTarget(
  preferredTarget: NfmSendToThreadPreferredTarget,
): string {
  return preferredTarget.kind === "thread"
    ? resolveNfmSendToThreadTitle(preferredTarget.thread)
    : (preferredTarget.label ?? "New chat");
}

export function resolveNfmSendToThreadTitle(thread: CodexThreadSummary): string {
  return resolveCodexElectronDisplayThreadTitle({
    threadName: thread.threadName,
    threadPreview: thread.threadPreview,
    fallback: formatThreadMentionShortUuid(thread.threadId),
  });
}

function newThreadMatchesQuery(
  row: Pick<NfmSendToThreadNewRow, "label" | "meta" | "target">,
  query: string,
): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  const haystack = normalizeSearchText([row.label, row.meta].join(" "));
  return haystack.includes(normalizedQuery);
}

function isAvailablePreferredThread(
  thread: CodexThreadSummary | null | undefined,
): thread is CodexThreadSummary {
  return Boolean(
    thread &&
    !thread.archived &&
    thread.ephemeral !== true &&
    thread.source?.sideConversation !== true,
  );
}

function threadActivity(
  statusType: CodexThreadSummary["statusType"],
  activeFlags: readonly string[],
): ChatActivity {
  if (statusType === "systemError") return "error";
  if (activeFlags.includes("waitingOnApproval")) return "waitingOnApproval";
  if (activeFlags.includes("waitingOnUserInput")) return "waitingOnUserInput";
  return statusType === "active" ? "running" : "idle";
}

function plainMatch(chat: ChatSearchMatch["chat"]): ChatSearchMatch {
  return { chat, titleRanges: [], hint: null, excerpt: null };
}

/** A started chat linked to the source Page, which may be older than any chat search lists. */
export function createLinkedChatMatch(item: PageChatItem): ChatSearchMatch | null {
  if (!item.threadId || item.sessionArchived || item.threadArchived) return null;
  const recencyAt = item.conversationRecencyAt ?? Date.parse(item.linkedAt);
  return plainMatch({
    sessionId: item.sessionId,
    threadId: item.threadId,
    title: item.displayTitle,
    projectId: item.projectId,
    projectName: item.projectName,
    cwd: null,
    branch: null,
    pullRequests: [],
    pinned: false,
    pinnedOrder: null,
    activity: item.threadStatus
      ? threadActivity(item.threadStatus.statusType, item.threadStatus.activeFlags)
      : "idle",
    createdAt: recencyAt,
    recencyAt,
  });
}

/** The editor's own chat, named by its Session before chat search lists it. */
function createPreferredThreadMatch(
  thread: CodexThreadSummary,
  sessionId: string,
  projectNameById: Readonly<Record<string, string>>,
): ChatSearchMatch | null {
  if (!isAvailablePreferredThread(thread)) return null;

  const projectId = thread.projectId?.trim() || null;
  return plainMatch({
    sessionId,
    threadId: thread.threadId,
    title: resolveNfmSendToThreadTitle(thread),
    projectId,
    projectName: projectId ? projectNameById[projectId]?.trim() || projectId : null,
    cwd: thread.cwd,
    branch: null,
    pullRequests: [],
    pinned: false,
    pinnedOrder: null,
    activity: threadActivity(thread.statusType, thread.statusActiveFlags),
    createdAt: thread.createdAt,
    recencyAt: thread.updatedAt,
  });
}

function createThreadRow(
  match: ChatSearchMatch,
  threadId: string,
  placement: { readonly meta: string; readonly preferred: boolean } | null,
): NfmSendToThreadExistingRow {
  return {
    kind: "thread",
    id: `thread:${threadId}`,
    threadId,
    label: match.chat.title || "New chat",
    meta: placement?.meta ?? (match.chat.projectName?.trim() || "Chats"),
    isPreferredTarget: placement?.preferred ?? false,
    match,
    target: {
      kind: "thread",
      threadId,
      sessionId: match.chat.sessionId,
    },
  };
}

function createPreferredNewThreadRow(
  preferredTarget: Extract<NfmSendToThreadPreferredTarget, { kind: "new-thread" }>,
): NfmSendToThreadNewRow {
  return {
    kind: "new-thread",
    id: `new-thread:${preferredTarget.sessionId}`,
    label: preferredTarget.label ?? "New chat",
    meta: preferredTarget.meta,
    isFooterAction: false,
    isPreferredTarget: true,
    target: {
      kind: "new-thread",
      sessionId: preferredTarget.sessionId,
    },
  };
}

function createProjectNewThreadRow(): NfmSendToThreadNewRow {
  return {
    kind: "new-thread",
    id: "new-thread",
    label: "New chat",
    meta: "This project",
    isFooterAction: true,
    isPreferredTarget: false,
    target: { kind: "new-thread" },
  };
}

export const LINKED_CHAT_LABEL = "Linked";

export function buildNfmSendToThreadRows({
  matches,
  linkedChats = [],
  query,
  preferredTarget = null,
  projectNameById = {},
}: NfmSendToThreadRowsInput): NfmSendToThreadRow[] {
  const searching = normalizeSearchText(query).length > 0;
  const preferredThreadId =
    preferredTarget?.kind === "thread" ? preferredTarget.thread.threadId : null;
  // The editor's chat leads the list; while searching, only when chat search matched it.
  const preferredMatch =
    preferredTarget?.kind === "thread"
      ? (matches.find((match) => match.chat.threadId === preferredThreadId) ??
        (searching
          ? null
          : createPreferredThreadMatch(
              preferredTarget.thread,
              preferredTarget.sessionId,
              projectNameById,
            )))
      : null;
  const preferredNewThreadRow =
    preferredTarget?.kind === "new-thread" ? createPreferredNewThreadRow(preferredTarget) : null;
  const visiblePreferredNewThreadRow =
    preferredNewThreadRow && newThreadMatchesQuery(preferredNewThreadRow, query)
      ? preferredNewThreadRow
      : null;
  const visibleLinkedChats = searching ? [] : linkedChats;
  const listedThreadIds = new Set<string | null>([preferredThreadId]);
  const rowsOnce = (
    candidates: readonly ChatSearchMatch[],
    placement: { readonly meta: string; readonly preferred: boolean } | null,
  ) =>
    candidates.flatMap((match) => {
      const threadId = match.chat.threadId;
      if (!threadId || listedThreadIds.has(threadId)) return [];
      listedThreadIds.add(threadId);
      return [createThreadRow(match, threadId, placement)];
    });
  const threadRows = [
    ...(preferredMatch && preferredThreadId && preferredTarget?.kind === "thread"
      ? [
          createThreadRow(preferredMatch, preferredThreadId, {
            meta: preferredTarget.meta,
            preferred: true,
          }),
        ]
      : []),
    ...rowsOnce(visibleLinkedChats, { meta: LINKED_CHAT_LABEL, preferred: false }),
    ...rowsOnce(matches, null),
  ];

  if (visiblePreferredNewThreadRow) {
    return [visiblePreferredNewThreadRow, ...threadRows];
  }

  return [...threadRows, createProjectNewThreadRow()];
}

function getInitialNfmSendToThreadFocusedRowId(
  query: string,
  rows: readonly NfmSendToThreadRow[],
): string | null {
  if (!normalizeSearchText(query)) return null;
  return rows.find((row) => row.kind === "thread")?.id ?? rows[0]?.id ?? null;
}

export function resolveNfmSendToThreadFocusedRowId(
  focusedRowId: string | null,
  query: string,
  rows: readonly NfmSendToThreadRow[],
): string | null {
  if (focusedRowId && rows.some((row) => row.id === focusedRowId)) {
    return focusedRowId;
  }

  return getInitialNfmSendToThreadFocusedRowId(query, rows);
}

export function moveNfmSendToThreadFocus(
  currentIndex: number,
  direction: 1 | -1,
  rows: readonly NfmSendToThreadRow[],
): number {
  if (rows.length === 0) return -1;
  if (currentIndex < 0) return direction > 0 ? 0 : rows.length - 1;

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0) return rows.length - 1;
  if (nextIndex >= rows.length) return 0;
  return nextIndex;
}

export function moveNfmSendToThreadFocusedRowId(
  focusedRowId: string | null,
  direction: 1 | -1,
  rows: readonly NfmSendToThreadRow[],
): string | null {
  if (rows.length === 0) return null;

  const currentIndex = focusedRowId ? rows.findIndex((row) => row.id === focusedRowId) : -1;
  const nextIndex = moveNfmSendToThreadFocus(currentIndex, direction, rows);
  return rows[nextIndex]?.id ?? null;
}
