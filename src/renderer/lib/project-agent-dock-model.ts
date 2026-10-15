import type { ProjectSessionSummary } from "../../shared/types";
import type { CodexPendingWorktreeEntry } from "../../shared/codex-pending-worktree";
import type { WorkbenchAgentDockState } from "../../shared/workbench-scene";
import { sortProjectSessionSummariesForSidebar } from "./project-session-query-cache";
import type { SessionLiveIndicator } from "./session-execution";

export type ProjectAgentDockAttention = "none" | "activity" | "request";
export type ProjectAgentDockChatIndicator =
  | "idle"
  | "running"
  | "background"
  | "unread"
  | "needs-attention";

export interface ProjectAgentDockTargetRow {
  readonly id: string;
  readonly kind: "new" | "session";
  readonly sessionId: string | null;
  /** Present for Runtime-bound Sessions, whose live status comes from Session activity. */
  readonly runtimeSessionId: string | null;
  readonly label: string;
  readonly preview: string | null;
  readonly selected: boolean;
  readonly attention: ProjectAgentDockAttention;
  readonly indicator: ProjectAgentDockChatIndicator;
}

export interface ProjectAgentDockModel {
  readonly trigger: ProjectAgentDockTargetRow;
  readonly rows: readonly ProjectAgentDockTargetRow[];
  readonly canSend: boolean;
  readonly collectionMessage: string | null;
  readonly hasMore: boolean;
}

export interface ProjectAgentDockPendingWorktreeModel {
  readonly clientThreadId: string;
  readonly statusLabel: string;
  readonly composerBlockedReason: string;
  readonly attention: Exclude<ProjectAgentDockAttention, "none">;
}

export type ProjectAgentDockPendingWorktreeEntry = Extract<
  CodexPendingWorktreeEntry,
  { readonly launchMode: "start-conversation" }
>;

export type ProjectAgentDockCollectionState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly refreshError: string | null }
  | { readonly kind: "error"; readonly message: string };

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function resolveProjectAgentDockPendingWorktree(
  entries: readonly CodexPendingWorktreeEntry[],
  projectSessionId: string | null,
  hasAttachedThread: boolean,
): ProjectAgentDockPendingWorktreeEntry | null {
  if (!projectSessionId || hasAttachedThread) return null;

  let latest: ProjectAgentDockPendingWorktreeEntry | null = null;
  for (const entry of entries) {
    if (entry.launchMode !== "start-conversation" || entry.projectSessionId !== projectSessionId) {
      continue;
    }
    if (
      latest === null ||
      entry.createdAt > latest.createdAt ||
      (entry.createdAt === latest.createdAt && entry.attempt > latest.attempt)
    ) {
      latest = entry;
    }
  }
  return latest;
}

export function buildProjectAgentDockPendingWorktreeModel(
  entry: ProjectAgentDockPendingWorktreeEntry,
): ProjectAgentDockPendingWorktreeModel {
  const statusLabel =
    entry.phase === "queued"
      ? "Queued…"
      : entry.phase === "creating"
        ? "Creating worktree…"
        : entry.phase === "setting-up"
          ? "Running setup…"
          : entry.phase === "worktree-ready"
            ? "Starting chat…"
            : "Setup failed";
  return {
    clientThreadId: entry.clientThreadId,
    statusLabel,
    composerBlockedReason:
      entry.phase === "failed"
        ? "Resolve the failed worktree setup before starting this chat again"
        : "Worktree setup is already in progress",
    attention: entry.phase === "failed" || entry.needsAttention ? "request" : "activity",
  };
}

function indicatorForSession(session: ProjectSessionSummary): ProjectAgentDockChatIndicator {
  const flags = session.thread?.statusActiveFlags ?? [];
  if (
    session.thread?.statusType === "systemError" ||
    flags.includes("waitingOnApproval") ||
    flags.includes("waitingOnUserInput")
  ) {
    return "needs-attention";
  }
  if (session.thread?.statusType === "active") return "running";
  if (session.unread) return "unread";
  return "idle";
}

export function attentionForIndicator(
  indicator: ProjectAgentDockChatIndicator,
): ProjectAgentDockAttention {
  if (indicator === "needs-attention") return "request";
  if (indicator === "running" || indicator === "background" || indicator === "unread")
    return "activity";
  return "none";
}

/** Runtime activity overrides the Core-derived indicator; idle Runtime chats keep unread state. */
export function resolveProjectAgentDockLiveIndicator(
  row: Pick<ProjectAgentDockTargetRow, "indicator" | "runtimeSessionId">,
  live: SessionLiveIndicator | null,
): ProjectAgentDockChatIndicator {
  if (!row.runtimeSessionId || !live) return row.indicator;
  return live === "waiting" ? "needs-attention" : live;
}

function sessionRow(
  session: ProjectSessionSummary,
  selectedSessionId: string | null,
): ProjectAgentDockTargetRow {
  const indicator = indicatorForSession(session);
  return {
    id: `session:${session.id}`,
    kind: "session",
    sessionId: session.id,
    runtimeSessionId: session.executionRef ? session.id : null,
    label: session.displayTitle || session.noThreadFallbackTitle || "New chat",
    preview: session.thread?.threadPreview.trim() || null,
    selected: session.id === selectedSessionId,
    attention: attentionForIndicator(indicator),
    indicator,
  };
}

function newChatRow(selected: boolean): ProjectAgentDockTargetRow {
  return {
    id: "new",
    kind: "new",
    sessionId: null,
    runtimeSessionId: null,
    label: "New chat",
    preview: null,
    selected,
    attention: "none",
    indicator: "idle",
  };
}

export function buildProjectAgentDockModel({
  projectId,
  dock,
  summaries,
  exactSelectedSession,
  collectionState,
  hasMore,
  query,
}: {
  readonly projectId: string;
  readonly dock: WorkbenchAgentDockState;
  readonly summaries: readonly ProjectSessionSummary[];
  readonly exactSelectedSession: ProjectSessionSummary | null;
  readonly collectionState: ProjectAgentDockCollectionState;
  readonly hasMore: boolean;
  readonly query: string;
}): ProjectAgentDockModel {
  const selectedSessionId = dock.binding.kind === "session" ? dock.binding.sessionId : null;
  const inScope = summaries.filter(
    (session) => session.projectId === projectId && !session.archived,
  );
  const selectedExact =
    exactSelectedSession?.projectId === projectId && !exactSelectedSession.archived
      ? exactSelectedSession
      : null;
  const withExact =
    selectedExact && !inScope.some((session) => session.id === selectedExact.id)
      ? [...inScope, selectedExact]
      : inScope;
  const normalizedQuery = normalizeSearch(query);
  const sessionRows = sortProjectSessionSummariesForSidebar(withExact)
    .map((session) => sessionRow(session, selectedSessionId))
    .filter((row) => {
      if (!normalizedQuery) return true;
      return normalizeSearch([row.label, row.preview ?? ""].join(" ")).includes(normalizedQuery);
    });
  const newRow = newChatRow(dock.binding.kind === "new");
  const trigger =
    dock.binding.kind === "new"
      ? newRow
      : (sessionRows.find((row) => row.sessionId === selectedSessionId) ?? {
          ...sessionRow(
            {
              id: selectedSessionId ?? "unavailable",
              projectId,
              noThreadFallbackTitle: "Chat unavailable",
              displayTitle: "Chat unavailable",
              order: Number.MAX_SAFE_INTEGER,
              pinned: false,
              pinnedOrder: null,
              archived: false,
              archivedAt: null,
              unread: false,
              thread: null,
              createdAt: "",
              updatedAt: "",
            },
            selectedSessionId,
          ),
          indicator: "needs-attention",
          attention: "request",
        });
  const collectionMessage =
    collectionState.kind === "loading"
      ? "Loading chats…"
      : collectionState.kind === "error"
        ? collectionState.message
        : collectionState.kind === "ready"
          ? collectionState.refreshError
          : null;

  return {
    trigger,
    rows: [newRow, ...sessionRows],
    canSend: dock.binding.kind === "new" || selectedExact !== null,
    collectionMessage,
    hasMore,
  };
}
