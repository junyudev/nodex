import { presentSessionTitle } from "@/lib/session-title-presentation";
import { getIntl } from "@/lib/i18n";
import { projectAutomationPromptPreview } from "../../shared/automation-heartbeat";
import type { ProjectSessionSummary } from "../../shared/types";
import type { CodexPendingWorktreeEntry } from "../../shared/codex-pending-worktree";
import type { WorkbenchAgentDockState } from "../../shared/workbench-scene";
import { sortProjectSessionSummariesForSidebar } from "./project-session-query-cache";
import type { SessionLiveIndicator } from "./session-execution";
import { nativeThreadWaitsOnPerson } from "./sidebar-status";

export type ProjectAgentDockAttention = "none" | "activity" | "request";
export type ProjectAgentDockChatIndicator =
  | "idle"
  | "running"
  | "background"
  | "unread"
  | "waiting"
  | "approval"
  | "error";

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
        ? getIntl().formatMessage({
            id: "lib.projectAgentDockModel.creatingWorktree",
            defaultMessage: "Creating worktree…",
          })
        : entry.phase === "setting-up"
          ? getIntl().formatMessage({
              id: "lib.projectAgentDockModel.setupRunning",
              defaultMessage: "Running setup…",
            })
          : entry.phase === "worktree-ready"
            ? getIntl().formatMessage({
                id: "lib.projectAgentDockModel.startingChat",
                defaultMessage: "Starting chat…",
              })
            : getIntl().formatMessage({
                id: "lib.projectAgentDockModel.setupFailed",
                defaultMessage: "Setup failed",
              });
  return {
    clientThreadId: entry.clientThreadId,
    statusLabel,
    composerBlockedReason:
      entry.phase === "failed"
        ? getIntl().formatMessage({
            id: "lib.projectAgentDockModel.setupBlocked",
            defaultMessage: "Resolve the failed worktree setup before starting this chat again",
          })
        : getIntl().formatMessage({
            id: "lib.projectAgentDockModel.setupInProgress",
            defaultMessage: "Worktree setup is already in progress",
          }),
    attention: entry.phase === "failed" || entry.needsAttention ? "request" : "activity",
  };
}

function indicatorForSession(session: ProjectSessionSummary): ProjectAgentDockChatIndicator {
  if (session.thread?.statusType === "systemError") return "error";
  if (session.thread?.statusActiveFlags.includes("waitingOnApproval")) return "approval";
  if (nativeThreadWaitsOnPerson(session.thread?.statusActiveFlags)) return "waiting";
  if (session.thread?.statusType === "active") return "running";
  if (session.unread) return "unread";
  return "idle";
}

export function attentionForIndicator(
  indicator: ProjectAgentDockChatIndicator,
): ProjectAgentDockAttention {
  if (indicator === "waiting" || indicator === "approval" || indicator === "error")
    return "request";
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
  return live;
}

function sessionRow(
  session: ProjectSessionSummary,
  selectedSessionId: string | null,
  intl: ReturnType<typeof getIntl>,
): ProjectAgentDockTargetRow {
  const indicator = indicatorForSession(session);
  return {
    id: `session:${session.id}`,
    kind: "session",
    sessionId: session.id,
    runtimeSessionId: session.executionRef ? session.id : null,
    label: presentSessionTitle(session, intl),
    preview: projectAutomationPromptPreview(session.thread?.threadPreview ?? "").trim() || null,
    selected: session.id === selectedSessionId,
    attention: attentionForIndicator(indicator),
    indicator,
  };
}

function newChatRow(
  selected: boolean,
  intl: ReturnType<typeof getIntl>,
): ProjectAgentDockTargetRow {
  return {
    id: "new",
    kind: "new",
    sessionId: null,
    runtimeSessionId: null,
    label: presentSessionTitle(null, intl),
    preview: null,
    selected,
    attention: "none",
    indicator: "idle",
  };
}

export function buildProjectAgentDockModel(
  {
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
  },
  intl = getIntl(),
): ProjectAgentDockModel {
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
    .map((session) => sessionRow(session, selectedSessionId, intl))
    .filter((row) => {
      if (!normalizedQuery) return true;
      return normalizeSearch([row.label, row.preview ?? ""].join(" ")).includes(normalizedQuery);
    });
  const newRow = newChatRow(dock.binding.kind === "new", intl);
  const trigger =
    dock.binding.kind === "new"
      ? newRow
      : (sessionRows.find((row) => row.sessionId === selectedSessionId) ?? {
          ...sessionRow(
            {
              id: selectedSessionId ?? "unavailable",
              projectId,
              noThreadFallbackTitle: intl.formatMessage({
                id: "lib.projectAgentDockModel.unavailable",
                defaultMessage: "Chat unavailable",
              }),
              displayTitle: intl.formatMessage({
                id: "lib.projectAgentDockModel.unavailable",
                defaultMessage: "Chat unavailable",
              }),
              activityAt: 0,
              managed: false,
              pinned: false,
              pinnedOrder: null,
              archived: false,
              archivedAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              wokeAt: null,
              pageTurn: null,
              canManage: false,
              canStop: false,
              unread: false,
              thread: null,
              createdAt: "",
              updatedAt: "",
            },
            selectedSessionId,
            intl,
          ),
          indicator: "error",
          attention: "request",
        });
  const collectionMessage =
    collectionState.kind === "loading"
      ? getIntl().formatMessage({
          id: "lib.projectAgentDockModel.loading",
          defaultMessage: "Loading chats…",
        })
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
