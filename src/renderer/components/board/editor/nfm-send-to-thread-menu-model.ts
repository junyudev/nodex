import { presentSessionTitle } from "@/lib/session-title-presentation";
import { getIntl, defineMessages, type IntlShape } from "@/lib/i18n";
import type { CodexThreadSummary, PageChatItem } from "@/lib/types";
import {
  CURRENT_CHAT_LABEL,
  CURRENT_CHAT_LABEL_MESSAGE,
  type ChatDestinationTarget,
} from "@/lib/page-chat-actions";
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
  intl = getIntl(),
): string {
  return preferredTarget.kind === "thread"
    ? resolveNfmSendToThreadTitle(preferredTarget.thread, intl)
    : presentSessionTitle(preferredTarget.label, intl);
}

export function resolveNfmSendToThreadTitle(thread: CodexThreadSummary, intl = getIntl()): string {
  return presentSessionTitle(
    resolveCodexElectronDisplayThreadTitle({
      threadName: thread.threadName,
      threadPreview: thread.threadPreview,
      fallback: formatThreadMentionShortUuid(thread.threadId),
    }),
    intl,
  );
}

function newThreadMatchesQuery(
  row: Pick<NfmSendToThreadNewRow, "label" | "meta" | "target">,
  query: string,
  intl: IntlShape,
): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  const newChatLabel = intl.formatMessage(chatPickerMessages.newChat);
  const englishAlias =
    row.label === newChatLabel && intl.locale === "zh-CN"
      ? chatPickerMessages.newChat.defaultMessage
      : undefined;
  const currentChatAlias =
    row.meta === intl.formatMessage(CURRENT_CHAT_LABEL_MESSAGE) ? CURRENT_CHAT_LABEL : undefined;
  const haystack = normalizeSearchText(
    [row.label, row.meta, englishAlias, currentChatAlias].filter(Boolean).join(" "),
  );
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
    unread: item.unread,
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
    unread: thread.hasUnreadTurn ?? false,
    activity: threadActivity(thread.statusType, thread.statusActiveFlags),
    createdAt: thread.createdAt,
    recencyAt: thread.updatedAt,
  });
}

function createThreadRow(
  match: ChatSearchMatch,
  threadId: string,
  placement: { readonly meta: string; readonly preferred: boolean } | null,
  intl: IntlShape,
): NfmSendToThreadExistingRow {
  return {
    kind: "thread",
    id: `thread:${threadId}`,
    threadId,
    label: presentSessionTitle(match.chat.title, intl),
    meta:
      placement?.meta ??
      (match.chat.projectName?.trim() ||
        intl.formatMessage({
          id: "editor.nfmSendToThreadMenuModel.chats",
          defaultMessage: "Chats",
        })),
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
  intl: IntlShape,
): NfmSendToThreadNewRow {
  return {
    kind: "new-thread",
    id: `new-thread:${preferredTarget.sessionId}`,
    label: presentSessionTitle(preferredTarget.label, intl),
    meta: formatPreferredTargetMeta(preferredTarget, intl),
    isFooterAction: false,
    isPreferredTarget: true,
    target: {
      kind: "new-thread",
      sessionId: preferredTarget.sessionId,
    },
  };
}

function createProjectNewThreadRow(intl: IntlShape): NfmSendToThreadNewRow {
  return {
    kind: "new-thread",
    id: "new-thread",
    label: intl.formatMessage(chatPickerMessages.newChat),
    meta: intl.formatMessage(chatPickerMessages.thisProject),
    isFooterAction: true,
    isPreferredTarget: false,
    target: { kind: "new-thread" },
  };
}

export const LINKED_CHAT_LABEL = "Linked";

const chatPickerMessages = defineMessages({
  newChat: { id: "editor.nfmSendToThreadMenuModel.newChat", defaultMessage: "New chat" },
  thisProject: {
    id: "editor.nfmSendToThreadMenuModel.thisProject",
    defaultMessage: "This project",
  },
});

function formatPreferredTargetMeta(
  target: NfmSendToThreadPreferredTarget,
  intl: IntlShape,
): string {
  return target.meta === CURRENT_CHAT_LABEL
    ? intl.formatMessage(CURRENT_CHAT_LABEL_MESSAGE)
    : target.meta;
}

export function buildNfmSendToThreadRows(
  {
    matches,
    linkedChats = [],
    query,
    preferredTarget = null,
    projectNameById = {},
  }: NfmSendToThreadRowsInput,
  intl = getIntl(),
): NfmSendToThreadRow[] {
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
    preferredTarget?.kind === "new-thread"
      ? createPreferredNewThreadRow(preferredTarget, intl)
      : null;
  const visiblePreferredNewThreadRow =
    preferredNewThreadRow && newThreadMatchesQuery(preferredNewThreadRow, query, intl)
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
      return [createThreadRow(match, threadId, placement, intl)];
    });
  const threadRows = [
    ...(preferredMatch && preferredThreadId && preferredTarget?.kind === "thread"
      ? [
          createThreadRow(
            preferredMatch,
            preferredThreadId,
            {
              meta: formatPreferredTargetMeta(preferredTarget, intl),
              preferred: true,
            },
            intl,
          ),
        ]
      : []),
    ...rowsOnce(visibleLinkedChats, {
      meta: intl.formatMessage({
        id: "editor.nfmSendToThreadMenuModel.linked",
        defaultMessage: "Linked",
      }),
      preferred: false,
    }),
    ...rowsOnce(matches, null),
  ];

  if (visiblePreferredNewThreadRow) {
    return [visiblePreferredNewThreadRow, ...threadRows];
  }

  return [...threadRows, createProjectNewThreadRow(intl)];
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
