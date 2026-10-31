import type { CodexThreadSummary } from "@/lib/types";
import type { CommandPaletteThread } from "@/lib/command-palette";
import { CURRENT_CHAT_LABEL, type ChatDestinationTarget } from "@/lib/page-chat-actions";
import { createCommandPaletteThreadSearchIndex } from "@/lib/command-palette-thread-search";
import { normalizeSearchText } from "@/lib/search-text";
import { formatThreadMentionShortUuid } from "@/lib/editor-model/thread-mention-display";
import { resolveCodexElectronDisplayThreadTitle } from "../../../../shared/codex-thread-title";

export type NfmSendToThreadMode = "send" | "wrap-toggle";

export type NfmSendToThreadTarget = ChatDestinationTarget;

export interface NfmSendToThreadRequest {
  target: NfmSendToThreadTarget;
  mode: NfmSendToThreadMode;
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
  statusLabel: string;
  isPreferredTarget: boolean;
  searchPreview?: CommandPaletteThread["searchPreview"] | null;
  thread: CommandPaletteThread;
  target: Extract<NfmSendToThreadTarget, { kind: "thread" }>;
}

export type NfmSendToThreadRow = NfmSendToThreadNewRow | NfmSendToThreadExistingRow;

export interface NfmSendToThreadRowsInput {
  threads: readonly CommandPaletteThread[];
  query: string;
  preferredTarget?: NfmSendToThreadPreferredTarget | null;
  projectNameById?: Readonly<Record<string, string>>;
  /** Wrapping leaves a mention of the chat, which only a chat with a Session can have. */
  requireSession?: boolean;
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

export function resolveNfmSendToThreadTitle(thread: CodexThreadSummary): string {
  return resolveCodexElectronDisplayThreadTitle({
    threadName: thread.threadName,
    threadPreview: thread.threadPreview,
    fallback: formatThreadMentionShortUuid(thread.threadId),
  });
}

function resolveThreadStatusLabel(
  thread: Pick<CommandPaletteThread, "statusType" | "statusActiveFlags">,
): string {
  if (thread.statusType === "systemError") return "Error";
  if (thread.statusActiveFlags.includes("waitingOnApproval")) return "Approval";
  if (thread.statusActiveFlags.includes("waitingOnUserInput")) return "Waiting";
  if (thread.statusType === "active") return "Running";
  return "Ready";
}

function preferredThreadMatchesQuery(thread: CommandPaletteThread, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  return createCommandPaletteThreadSearchIndex([thread]).search(normalizedQuery).length > 0;
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

function createPreferredThreadItem(
  thread: CodexThreadSummary,
  sessionId: string,
  projectNameById: Readonly<Record<string, string>>,
): CommandPaletteThread | null {
  if (!isAvailablePreferredThread(thread)) return null;

  const projectId = thread.projectId?.trim() || null;
  const projectName = projectId ? projectNameById[projectId]?.trim() || projectId : null;
  return {
    kind: "thread",
    id: `thread:${thread.threadId}`,
    threadId: thread.threadId,
    sessionId,
    projectId,
    projectName,
    title: resolveNfmSendToThreadTitle(thread),
    preview: thread.threadPreview,
    cwd: thread.cwd,
    gitBranch: null,
    projectless: projectId === null,
    pinned: false,
    pinnedOrder: null,
    statusType: thread.statusType,
    statusActiveFlags: thread.statusActiveFlags,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    inActiveProject: false,
  };
}

function resolveThreadProjectLabel(thread: CommandPaletteThread): string {
  return thread.projectName?.trim() || "Chats";
}

function createThreadRow(
  thread: CommandPaletteThread,
  preferredMeta: string | null,
): NfmSendToThreadExistingRow {
  const statusLabel = resolveThreadStatusLabel(thread);
  return {
    kind: "thread",
    id: `thread:${thread.threadId}`,
    threadId: thread.threadId,
    label: thread.title || "New chat",
    meta: preferredMeta ?? resolveThreadProjectLabel(thread),
    statusLabel,
    isPreferredTarget: preferredMeta !== null,
    searchPreview: thread.searchPreview,
    thread,
    target: {
      kind: "thread",
      threadId: thread.threadId,
      sessionId: thread.sessionId,
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

export function buildNfmSendToThreadRows({
  threads,
  query,
  preferredTarget = null,
  projectNameById = {},
  requireSession = false,
}: NfmSendToThreadRowsInput): NfmSendToThreadRow[] {
  const preferredExistingThreadId =
    preferredTarget?.kind === "thread" ? preferredTarget.thread.threadId : null;
  const preferredThreadFromResults = preferredExistingThreadId
    ? (threads.find((thread) => thread.threadId === preferredExistingThreadId) ?? null)
    : null;
  const preferredThreadFallback =
    preferredTarget?.kind === "thread"
      ? createPreferredThreadItem(
          preferredTarget.thread,
          preferredTarget.sessionId,
          projectNameById,
        )
      : null;
  // The editor's own Session names its chat even when the chat list has not caught up.
  const preferredThread =
    preferredThreadFromResults && preferredTarget?.kind === "thread"
      ? { ...preferredThreadFromResults, sessionId: preferredTarget.sessionId }
      : preferredThreadFallback;
  const visiblePreferredThread =
    preferredThread && preferredThreadMatchesQuery(preferredThread, query) ? preferredThread : null;
  const preferredNewThreadRow =
    preferredTarget?.kind === "new-thread" ? createPreferredNewThreadRow(preferredTarget) : null;
  const visiblePreferredNewThreadRow =
    preferredNewThreadRow && newThreadMatchesQuery(preferredNewThreadRow, query)
      ? preferredNewThreadRow
      : null;
  const threadRows = [
    ...(visiblePreferredThread
      ? [
          createThreadRow(
            visiblePreferredThread,
            preferredTarget?.kind === "thread" ? preferredTarget.meta : null,
          ),
        ]
      : []),
    ...threads
      .filter((thread) => thread.threadId !== visiblePreferredThread?.threadId)
      .map((thread) => createThreadRow(thread, null)),
  ].filter((row) => !requireSession || row.target.sessionId !== null);

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
