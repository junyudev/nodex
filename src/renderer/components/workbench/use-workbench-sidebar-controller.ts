import { useCallback, useEffect, type MouseEvent as ReactMouseEvent } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { ensureFreshDatabaseViewBoard } from "@/lib/board-store";
import { invoke, invokeCoreResult } from "@/lib/api";
import { listAllSidebarSections } from "@/lib/sidebar-sections-api";
import { buildSessionDeepLink } from "@/lib/page-deeplink";
import { documentSessionRegistry } from "@/lib/document-session-registry";
import { queryKeys } from "@/lib/query-keys";
import {
  loadLocalEnvironmentConfigSelection,
  readLocalEnvironmentSelections,
} from "./local-environment-selection";
import type { ScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import {
  buildSessionContextMenuItems,
  readSessionMoveToProjectActionId,
  readSessionMoveToSectionActionId,
  readSessionOpenInActionId,
  resolveSessionProjectMoveContainers,
  SESSION_CONTEXT_MENU_ACTION_IDS,
} from "./session-context-menu-model";
import { showNativeContextMenu } from "@/lib/native-context-menu";
import { toast } from "@/components/ui/toast";
import { writeTextToClipboard } from "@/lib/clipboard";
import { presentWorkbenchSessionDomainWithScene } from "@/lib/workbench-scene-presentation";
import {
  presentWorkbenchSession,
  type WorkbenchSessionRenderProjection,
} from "@/lib/workbench-session-presentation";
import type {
  WorkbenchSessionCatalog,
  WorkbenchSessionCatalogWindowPort,
} from "@/lib/use-workbench-session-catalog";
import type { WorkbenchPanelController } from "@/lib/use-workbench-panel-controller";
import type { useWorkbenchSidebarState } from "@/lib/use-workbench-sidebar-state";
import type { useSidebarThreadSyncModel } from "@/lib/use-sidebar-thread-sync-model";
import type { useCodexAppServerControl } from "@/features/local-conversation";
import type { CodexSidebarThreadSyncModel } from "@/lib/codex-sidebar-thread-sync";
import type {
  CodexSidebarThreadItem,
  Project,
  ProjectSession as ProjectSessionDomain,
} from "@/lib/types";
import {
  isCodexSidebarThreadContainerId,
  type CodexSidebarThreadMoveInput,
  type CodexSidebarThreadMovePlacement,
  type CodexSidebarThreadMoveSuccess,
} from "../../../shared/codex-sidebar-thread-move";
import { RenameChatDialog } from "./rename-chat-dialog";
import { SidebarThreadMoveConfirmationDialog } from "./sidebar-thread-move-confirmation-dialog";
import { SIDEBAR_SECTIONS_QUERY_KEY } from "./sidebar-custom-sections";
import { SidebarSectionNameDialog } from "./sidebar-section-name-dialog";
import type { SidebarThreadDropCommit, SidebarThreadDropRequest } from "./sidebar-thread-reorder";
import { copyConversationMarkdown } from "@/features/local-conversation/copy-conversation-markdown";
import { readFileLinkOpener } from "@/lib/file-link-opener-settings";
import { FILE_LINK_OPENER_ICON_URLS } from "@/lib/file-link-opener-icons";
import { FILE_LINK_OPENER_OPTIONS } from "../../../shared/file-link-openers";

type ProjectSession = WorkbenchSessionRenderProjection;
type SidebarState = Pick<
  ReturnType<typeof useWorkbenchSidebarState>,
  | "beginArchive"
  | "beginContextMenu"
  | "ensureProjectExpanded"
  | "finishArchive"
  | "finishContextMenu"
>;
type SidebarSync = Pick<
  ReturnType<typeof useSidebarThreadSyncModel>,
  "applySnapshot" | "refresh" | "setPinned"
>;

interface WorkbenchSidebarControllerInput {
  readonly projects: Project[];
  readonly projectlessSessions: readonly ProjectSession[];
  readonly knownSessions: readonly ProjectSession[];
  readonly activeProject: Project | null;
  readonly activeSessionId: string | null;
  readonly activeSessions: readonly ProjectSession[];
  readonly pendingSessionOpen?: {
    readonly projectId: string | null;
    readonly sessionId: string;
  } | null;
  readonly pendingWorktreeClientThreadId: string | null;
  readonly catalog: WorkbenchSessionCatalog;
  readonly window: WorkbenchSessionCatalogWindowPort;
  readonly panelController: WorkbenchPanelController;
  readonly codexControl: ReturnType<typeof useCodexAppServerControl>;
  readonly sidebarState: SidebarState;
  readonly sidebarSync: SidebarSync;
  readonly sidebarThreadModel: CodexSidebarThreadSyncModel;
  readonly queryClient: QueryClient;
  readonly appHandle: ScopeHandle;
  readonly setSettingsPath: (path: string | null) => void;
  readonly setAutomationsPath: (path: string | null) => void;
  readonly setPendingWorktreeClientThreadId: (clientThreadId: string | null) => void;
  readonly setLocalEnvironmentSettingsInitial: (value: null) => void;
  readonly closePendingWorktreeRoute: () => void;
  readonly onOpenProjectSessionInNewWindow?: (session: ProjectSession) => Promise<void>;
}

function listSessionDbViewTargets(
  session: ProjectSession,
): Array<{ projectId: string; databaseViewId: string }> {
  const targets = new Map<string, { projectId: string; databaseViewId: string }>();
  for (const tab of session.tabs) {
    if (tab.kind !== "db_view") continue;
    if (!("projectId" in tab.config)) continue;
    if (tab.config.projectId === null) continue;
    if (!("databaseViewId" in tab.config)) continue;
    if (typeof tab.config.databaseViewId !== "string") continue;
    const databaseViewId = tab.config.databaseViewId.trim();
    if (!databaseViewId) continue;
    targets.set(databaseViewId, {
      projectId: tab.config.projectId,
      databaseViewId,
    });
  }
  return [...targets.values()];
}

/**
 * Owns the Sidebar Module's session catalog commands and native menu Adapter.
 *
 * The Shell supplies routing and storage ports; this hook owns all behavior
 * attached to Sidebar project/session/thread affordances.
 */
export function useWorkbenchSidebarController({
  projects,
  projectlessSessions,
  knownSessions,
  activeProject,
  activeSessionId,
  activeSessions,
  pendingSessionOpen,
  pendingWorktreeClientThreadId,
  catalog,
  window: workbenchWindow,
  panelController,
  codexControl,
  sidebarState,
  sidebarSync,
  sidebarThreadModel,
  queryClient,
  appHandle,
  setSettingsPath,
  setAutomationsPath,
  setPendingWorktreeClientThreadId,
  setLocalEnvironmentSettingsInitial,
  closePendingWorktreeRoute,
  onOpenProjectSessionInNewWindow,
}: WorkbenchSidebarControllerInput) {
  const {
    beginArchive,
    beginContextMenu,
    ensureProjectExpanded,
    finishArchive,
    finishContextMenu,
  } = sidebarState;
  const { refresh: refreshSidebarThreadSnapshot, setPinned: setSidebarThreadPinned } = sidebarSync;

  const refreshProjectSessions = useCallback(
    async (projectId: string | null) => {
      const presentations = await catalog.refresh(projectId);
      return presentations.map(presentWorkbenchSession);
    },
    [catalog],
  );

  const moveSidebarThreadInputForSidebar = useCallback(
    async (initialInput: CodexSidebarThreadMoveInput) => {
      const submitMove = async (
        moveInput: CodexSidebarThreadMoveInput,
      ): Promise<CodexSidebarThreadMoveSuccess | null> => {
        try {
          const result = await invoke("codex:sidebar:thread:move", moveInput);
          if (result.status === "confirmation-required") {
            openModal(appHandle, SidebarThreadMoveConfirmationDialog, {
              confirmation: result,
              onContinue: () => {
                void submitMove({
                  ...moveInput,
                  projectAccessGrant: {
                    targetProjectId: result.targetProjectId,
                    expectedBindingRevision: result.targetBindingRevision,
                    missingProjectSources: result.missingProjectSources,
                  },
                });
              },
            });
            return null;
          }

          const scopeIds = new Set([result.source.projectId, result.destination.projectId]);
          await Promise.all(
            [...scopeIds].map(async (projectId) => {
              await catalog.refreshThrough(projectId, result.projectionRevision);
            }),
          );
          if (moveInput.projectAccessGrant) {
            await queryClient.invalidateQueries({
              queryKey: queryKeys.projects.all(),
            });
          }
          return result;
        } catch {
          toast.danger("Couldn’t move chat");
          return null;
        }
      };

      return await submitMove(initialInput);
    },
    [appHandle, catalog, queryClient],
  );

  const moveSidebarThreadForSidebar = useCallback(
    async (drop: SidebarThreadDropRequest): Promise<SidebarThreadDropCommit | null> => {
      if (
        !isCodexSidebarThreadContainerId(drop.sourceContainerId) ||
        !isCodexSidebarThreadContainerId(drop.targetContainerId)
      ) {
        throw new Error("Invalid sidebar thread move container");
      }

      const placement: CodexSidebarThreadMovePlacement = drop.useDefaultOrder
        ? { beforeThreadId: null, useDefaultOrder: true }
        : drop.afterThreadId !== undefined
          ? { beforeThreadId: null, afterThreadId: drop.afterThreadId }
          : drop.insertAtEnd
            ? { beforeThreadId: null, insertAtEnd: true }
            : drop.beforeThreadId === null
              ? { beforeThreadId: null }
              : { beforeThreadId: drop.beforeThreadId };
      const result = await moveSidebarThreadInputForSidebar({
        hostId: "local",
        threadId: drop.threadId,
        sourceContainerId: drop.sourceContainerId,
        targetContainerId: drop.targetContainerId,
        ...placement,
      });
      return result === null
        ? null
        : {
            operationId: result.operationId,
            projectionRevision: result.projectionRevision,
          };
    },
    [moveSidebarThreadInputForSidebar],
  );

  const mergeSessionInState = useCallback(
    (session: ProjectSessionDomain) => {
      catalog.seed(session);
    },
    [catalog],
  );

  const warmProjectSessionDbViewBoards = useCallback(
    (session: ProjectSessionDomain | ProjectSession) => {
      const projected =
        "tabs" in session
          ? session
          : presentWorkbenchSessionDomainWithScene(session, catalog.resolveScene(session));
      for (const target of listSessionDbViewTargets(projected)) {
        void ensureFreshDatabaseViewBoard(target.projectId, target.databaseViewId).catch(
          () => undefined,
        );
      }
    },
    [catalog],
  );

  const prefetchSidebarSession = useCallback(
    (item: CodexSidebarThreadItem) => {
      if (item.disabled) return;

      const session = item.sessionId
        ? (knownSessions.find((candidate) => candidate.id === item.sessionId) ?? null)
        : (knownSessions.find((candidate) => candidate.thread?.threadId === item.threadId) ?? null);
      const sessionId = item.sessionId ?? session?.id ?? null;
      if (!sessionId) return;

      void catalog
        .prefetch(sessionId)
        .then((detail) => {
          if (detail) warmProjectSessionDbViewBoards(detail);
        })
        .catch(() => undefined);
    },
    [catalog, knownSessions, warmProjectSessionDbViewBoards],
  );

  useEffect(() => {
    if (!catalog.active) return;
    warmProjectSessionDbViewBoards(catalog.active.domain);
  }, [catalog.active, warmProjectSessionDbViewBoards]);

  const resolveForkLocalEnvironmentConfigPath = useCallback(
    async (workspaceRoot: string | null | undefined): Promise<string | null> => {
      return await loadLocalEnvironmentConfigSelection({
        workspaceRoot,
        selectionsByWorkspace: readLocalEnvironmentSelections(),
        loadCandidates: async (resolvedWorkspaceRoot) =>
          await invoke(
            "worktrees:environments:configs:list-for-workspace",
            "local",
            resolvedWorkspaceRoot,
          ),
      });
    },
    [],
  );

  const selectProject = useCallback(
    (projectId: string) => {
      workbenchWindow.selectProject(projectId);
      ensureProjectExpanded(projectId);
    },
    [ensureProjectExpanded, workbenchWindow],
  );

  const selectSession = useCallback(
    (session: ProjectSessionDomain | ProjectSession) => {
      const catalogPresentation = catalog.findById(session.id);
      const domainSession = catalogPresentation?.domain ?? session;
      const targetSession = catalogPresentation
        ? presentWorkbenchSession(catalogPresentation)
        : presentWorkbenchSessionDomainWithScene(
            domainSession,
            catalog.resolveScene(domainSession),
          );
      warmProjectSessionDbViewBoards(targetSession);

      catalog.select(domainSession);
      if (targetSession.projectId !== null) {
        ensureProjectExpanded(targetSession.projectId);
      }

      if (!targetSession.unread) return;
      const threadId = targetSession.thread?.threadId ?? null;
      if (threadId) {
        void codexControl.markConversationAsRead(threadId).catch(() => undefined);
        return;
      }
      void catalog
        .markUnread(domainSession, false)
        .then((updated) => {
          if (!updated) return;
          mergeSessionInState(updated);
        })
        .catch(() => undefined);
    },
    [
      catalog,
      codexControl,
      ensureProjectExpanded,
      mergeSessionInState,
      warmProjectSessionDbViewBoards,
    ],
  );

  useEffect(() => {
    if (!pendingSessionOpen) return;
    if (pendingSessionOpen.projectId === null) {
      const targetSession = projectlessSessions.find(
        (session) => session.id === pendingSessionOpen.sessionId,
      );
      if (!targetSession) return;
      selectSession(targetSession);
      return;
    }
    if (pendingSessionOpen.projectId !== activeProject?.id) return;
    const targetSession = activeSessions.find(
      (session) => session.id === pendingSessionOpen.sessionId,
    );
    if (!targetSession) return;
    selectSession(targetSession);
  }, [activeProject?.id, activeSessions, pendingSessionOpen, projectlessSessions, selectSession]);

  const toggleSessionPin = useCallback(
    async (session: ProjectSessionDomain) => {
      const nextPinned = !session.pinned;
      if (session.thread) {
        try {
          await setSidebarThreadPinned(session.thread.threadId, nextPinned);
          const updatedSessions = await refreshProjectSessions(session.projectId);
          const updatedSession = updatedSessions.find((candidate) => candidate.id === session.id);
          if (updatedSession) mergeSessionInState(updatedSession);
        } catch {
          toast.danger(nextPinned ? "Failed to pin chat" : "Failed to unpin chat");
        }
        return;
      }

      try {
        await catalog.setPinned(session, nextPinned);
      } catch {
        toast.danger(nextPinned ? "Failed to pin chat" : "Failed to unpin chat");
      }
    },
    [catalog, mergeSessionInState, refreshProjectSessions, setSidebarThreadPinned],
  );

  const toggleSidebarThreadPinned = useCallback(
    async (item: CodexSidebarThreadItem) => {
      if (item.disabled) return;
      const nextPinned = !item.pinned;
      try {
        if (item.kind === "pending-worktree") {
          if (!item.pendingWorktreeId) return;
          await invoke(
            "codex:pending-worktree:set-pinned",
            item.hostId,
            item.pendingWorktreeId,
            nextPinned,
          );
          return;
        }
        await setSidebarThreadPinned(item.threadId, nextPinned);
        const session = item.sessionId
          ? (knownSessions.find((candidate) => candidate.id === item.sessionId) ?? null)
          : null;
        if (!session) return;
        const refreshed = await refreshProjectSessions(session.projectId);
        const updatedSession = refreshed.find((candidate) => candidate.id === session.id);
        if (updatedSession) mergeSessionInState(updatedSession);
      } catch {
        toast.danger(nextPinned ? "Failed to pin chat" : "Failed to unpin chat");
      }
    },
    [knownSessions, mergeSessionInState, refreshProjectSessions, setSidebarThreadPinned],
  );

  const selectSidebarThread = useCallback(
    async (item: CodexSidebarThreadItem) => {
      if (item.disabled) return;
      if (item.kind === "pending-worktree") {
        setSettingsPath(null);
        setLocalEnvironmentSettingsInitial(null);
        setAutomationsPath(null);
        setPendingWorktreeClientThreadId(item.threadId);
        return;
      }
      const existingSession = item.sessionId
        ? (knownSessions.find((candidate) => candidate.id === item.sessionId) ?? null)
        : (knownSessions.find((candidate) => candidate.thread?.threadId === item.threadId) ?? null);
      if (existingSession) {
        selectSession(existingSession);
        return;
      }

      try {
        const ensured = await catalog.ensureThreadSession(item.threadId);
        if (!ensured) {
          toast.info("That chat is not available", {
            id: `thread-open-unavailable-${item.threadId}`,
          });
          return;
        }
        selectSession(ensured);
      } catch {
        toast.danger("Failed to open chat");
      }
    },
    [
      catalog,
      knownSessions,
      selectSession,
      setAutomationsPath,
      setLocalEnvironmentSettingsInitial,
      setPendingWorktreeClientThreadId,
      setSettingsPath,
    ],
  );

  const openRenameSessionDialog = useCallback(
    (session: ProjectSessionDomain) => {
      openModal(appHandle, RenameChatDialog, {
        initialValue: session.displayTitle,
        onSave: (title) => {
          void catalog.rename(session, title).catch(() => {
            toast.danger("Failed to rename chat");
          });
        },
      });
    },
    [appHandle, catalog],
  );

  const handleSessionTitleDoubleClick = useCallback(
    (session: ProjectSessionDomain, event: ReactMouseEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      if (activeSessionId !== session.id) return;
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest("[data-thread-title]")) return;

      const pointerCancelEvent =
        typeof PointerEvent === "function"
          ? new PointerEvent("pointercancel", { bubbles: true, cancelable: true })
          : new Event("pointercancel", { bubbles: true, cancelable: true });
      event.currentTarget.dispatchEvent(pointerCancelEvent);
      openRenameSessionDialog(session);
    },
    [activeSessionId, openRenameSessionDialog],
  );

  const handlePendingWorktreeTitleDoubleClick = useCallback(
    (item: CodexSidebarThreadItem, event: ReactMouseEvent<HTMLElement>) => {
      if (event.defaultPrevented || item.kind !== "pending-worktree") return;
      openModal(appHandle, RenameChatDialog, {
        initialValue: item.title,
        requireNonEmpty: true,
        onSave: (label) => {
          if (!item.pendingWorktreeId) return;
          void invoke(
            "codex:pending-worktree:rename",
            item.hostId,
            item.pendingWorktreeId,
            label,
          ).catch(() => {
            toast.danger("Failed to rename task");
          });
        },
      });
    },
    [appHandle],
  );

  const archiveSession = useCallback(
    async (session: ProjectSessionDomain, options: { showToast?: boolean } = {}) => {
      try {
        const refreshedPresentations = await catalog.archive(session);
        try {
          await refreshSidebarThreadSnapshot();
          if (activeSessionId === session.id) {
            const sessions = refreshedPresentations.map(presentWorkbenchSession);
            const fallbackSession =
              sessions[0] ?? (session.projectId === null ? (activeSessions[0] ?? null) : null);
            if (fallbackSession) {
              selectSession(fallbackSession);
            } else {
              workbenchWindow.selectProject(session.projectId);
            }
          }
        } finally {
          panelController.pruneSession(session.id);
          await documentSessionRegistry.disposeProjectSession(session.id);
        }
        return true;
      } catch {
        if (options.showToast !== false) {
          toast.danger("Failed to archive chat");
        }
        return false;
      }
    },
    [
      activeSessionId,
      activeSessions,
      catalog,
      panelController,
      refreshSidebarThreadSnapshot,
      selectSession,
      workbenchWindow,
    ],
  );

  const resolveSidebarArchivePendingKeyForSession = useCallback(
    (session: ProjectSessionDomain) => {
      for (const [key, item] of sidebarThreadModel.threadItemsByKey) {
        if (item.sessionId === session.id) return key;
        if (session.thread && item.threadId === session.thread.threadId) return key;
      }
      return `local:session:${session.id}`;
    },
    [sidebarThreadModel.threadItemsByKey],
  );

  const archiveSessionWithSidebarPendingState = useCallback(
    async (session: ProjectSessionDomain) => {
      const pendingKey = resolveSidebarArchivePendingKeyForSession(session);
      if (!beginArchive(pendingKey)) return;

      try {
        const archived = await archiveSession(session, { showToast: false });
        if (!archived) toast.danger("Failed to archive chat");
      } finally {
        finishArchive(pendingKey);
      }
    },
    [archiveSession, beginArchive, finishArchive, resolveSidebarArchivePendingKeyForSession],
  );

  const archiveSidebarThreadItem = useCallback(
    async (item: CodexSidebarThreadItem, sessionOverride?: ProjectSessionDomain) => {
      if (item.disabled || !beginArchive(item.key)) return;

      try {
        if (item.kind === "pending-worktree") {
          if (!item.pendingWorktreeId) return;
          await invoke("codex:pending-worktree:cancel", item.hostId, item.pendingWorktreeId);
          if (item.threadId === pendingWorktreeClientThreadId) {
            closePendingWorktreeRoute();
          }
          return;
        }

        const session =
          sessionOverride ??
          (item.sessionId
            ? (knownSessions.find((candidate) => candidate.id === item.sessionId) ?? null)
            : (knownSessions.find((candidate) => candidate.thread?.threadId === item.threadId) ??
              null));
        if (session) {
          const archived = await archiveSession(session, { showToast: false });
          if (!archived) toast.danger("Failed to archive chat");
          return;
        }

        await invoke("codex:thread:archive", item.threadId);
        await refreshSidebarThreadSnapshot();
      } catch {
        toast.danger(
          item.kind === "pending-worktree"
            ? "Failed to cancel worktree setup"
            : "Failed to archive chat",
        );
      } finally {
        finishArchive(item.key);
      }
    },
    [
      archiveSession,
      beginArchive,
      closePendingWorktreeRoute,
      finishArchive,
      knownSessions,
      pendingWorktreeClientThreadId,
      refreshSidebarThreadSnapshot,
    ],
  );

  const archiveSidebarThreadItemQuiet = useCallback(
    async (item: CodexSidebarThreadItem): Promise<boolean> => {
      if (item.disabled || item.kind === "pending-worktree") return false;
      if (!beginArchive(item.key)) return false;

      try {
        const session = item.sessionId
          ? (knownSessions.find((candidate) => candidate.id === item.sessionId) ?? null)
          : (knownSessions.find((candidate) => candidate.thread?.threadId === item.threadId) ??
            null);
        if (session) {
          return await archiveSession(session, { showToast: false });
        }

        await invoke("codex:thread:archive", item.threadId);
        return true;
      } catch {
        return false;
      } finally {
        finishArchive(item.key);
      }
    },
    [archiveSession, beginArchive, finishArchive, knownSessions],
  );

  const markSidebarThreadItemRead = useCallback(
    async (item: CodexSidebarThreadItem) => {
      const session = item.sessionId
        ? (knownSessions.find((candidate) => candidate.id === item.sessionId) ?? null)
        : (knownSessions.find((candidate) => candidate.thread?.threadId === item.threadId) ?? null);
      if (session?.thread?.threadId) {
        await codexControl.markConversationAsRead(session.thread.threadId);
        mergeSessionInState({ ...session, unread: false });
        return;
      }
      if (session) {
        const updated = await catalog.markUnread(session, false);
        if (updated) mergeSessionInState(updated);
        return;
      }
      await codexControl.markConversationAsRead(item.threadId);
    },
    [catalog, codexControl, knownSessions, mergeSessionInState],
  );

  const toggleSessionUnread = useCallback(
    async (session: ProjectSessionDomain) => {
      const hasUnreadTurn = !session.unread;
      try {
        if (session.thread?.threadId) {
          if (hasUnreadTurn) {
            await codexControl.markConversationAsUnread(session.thread.threadId);
          } else {
            await codexControl.markConversationAsRead(session.thread.threadId);
          }
          mergeSessionInState({ ...session, unread: hasUnreadTurn });
          return;
        }
        const updated = await catalog.markUnread(session, hasUnreadTurn);
        if (updated) mergeSessionInState(updated);
      } catch {
        toast.danger(hasUnreadTurn ? "Failed to mark chat unread" : "Failed to mark chat read");
      }
    },
    [catalog, codexControl, mergeSessionInState],
  );

  const copySessionText = useCallback(
    async (text: string, successMessage: string, errorMessage: string) => {
      const copied = await writeTextToClipboard(text);
      if (copied) {
        toast.success(successMessage);
        return;
      }
      toast.danger(errorMessage);
    },
    [],
  );

  const handleSessionContextMenuAction = useCallback(
    async (session: ProjectSessionDomain, actionId: string) => {
      const moveTargetSectionId = readSessionMoveToSectionActionId(actionId);
      if (moveTargetSectionId) {
        await invokeCoreResult("sidebar-sections:item:move", {
          item: { kind: "session", sessionId: session.id },
          sectionId: moveTargetSectionId,
          placement: { kind: "end" },
        });
        await queryClient.invalidateQueries({ queryKey: SIDEBAR_SECTIONS_QUERY_KEY });
        return;
      }
      if (actionId === SESSION_CONTEXT_MENU_ACTION_IDS.newSection) {
        openModal(appHandle, SidebarSectionNameDialog, {
          title: "New section",
          description: "Create a section and move this chat into it.",
          allowEmpty: true,
          onSave: async (name) => {
            await invokeCoreResult("sidebar-sections:create", {
              name,
              initialItem: { kind: "session", sessionId: session.id },
            });
            await queryClient.invalidateQueries({ queryKey: SIDEBAR_SECTIONS_QUERY_KEY });
          },
        });
        return;
      }
      if (actionId === SESSION_CONTEXT_MENU_ACTION_IDS.removeFromSection) {
        await invokeCoreResult("sidebar-sections:item:move", {
          item: { kind: "session", sessionId: session.id },
          sectionId: null,
          placement: { kind: "end" },
        });
        await queryClient.invalidateQueries({ queryKey: SIDEBAR_SECTIONS_QUERY_KEY });
        return;
      }
      const moveTargetProjectId = readSessionMoveToProjectActionId(actionId);
      if (moveTargetProjectId || actionId === SESSION_CONTEXT_MENU_ACTION_IDS.removeFromProject) {
        const threadId = session.thread?.threadId;
        if (!threadId) return;
        const containers = resolveSessionProjectMoveContainers(session, moveTargetProjectId);
        await moveSidebarThreadInputForSidebar({
          hostId: "local",
          threadId,
          ...containers,
          beforeThreadId: null,
        });
        return;
      }
      if (actionId === SESSION_CONTEXT_MENU_ACTION_IDS.togglePin) {
        await toggleSessionPin(session);
        return;
      }
      if (actionId === SESSION_CONTEXT_MENU_ACTION_IDS.rename) {
        openRenameSessionDialog(session);
        return;
      }
      if (actionId === SESSION_CONTEXT_MENU_ACTION_IDS.archive) {
        await archiveSessionWithSidebarPendingState(session);
        return;
      }
      if (actionId === SESSION_CONTEXT_MENU_ACTION_IDS.markUnread) {
        await toggleSessionUnread(session);
        return;
      }
      if (actionId === SESSION_CONTEXT_MENU_ACTION_IDS.copyWorkingDirectory) {
        await copySessionText(
          session.thread?.cwd ?? "",
          "Copied working directory",
          "Failed to copy working directory",
        );
        return;
      }
      if (actionId === SESSION_CONTEXT_MENU_ACTION_IDS.copyDeeplink) {
        await copySessionText(
          buildSessionDeepLink({ sessionId: session.id }),
          "Copied deeplink",
          "Failed to copy deeplink",
        );
        return;
      }
      if (actionId === SESSION_CONTEXT_MENU_ACTION_IDS.copyConversationMarkdown) {
        const conversationId = session.thread?.threadId;
        if (!conversationId) return;
        await copyConversationMarkdown({
          conversationId,
          title: session.displayTitle || session.noThreadFallbackTitle,
        });
        return;
      }
      const openerId = readSessionOpenInActionId(actionId);
      if (openerId) {
        if (!FILE_LINK_OPENER_OPTIONS.some((option) => option.id === openerId)) return;
        const cwd = session.thread?.cwd?.trim();
        if (!cwd) return;
        const opened = await invoke("shell:open-file-link", { path: cwd }, openerId);
        if (!opened) toast.danger("Failed to open working directory");
        return;
      }
      if (actionId === SESSION_CONTEXT_MENU_ACTION_IDS.openInNewWindow) {
        const presentation = catalog.findById(session.id);
        const projectedSession = presentation
          ? presentWorkbenchSession(presentation)
          : presentWorkbenchSessionDomainWithScene(session, catalog.resolveScene(session));
        await onOpenProjectSessionInNewWindow?.(projectedSession);
      }
    },
    [
      archiveSessionWithSidebarPendingState,
      appHandle,
      catalog,
      copySessionText,
      moveSidebarThreadInputForSidebar,
      onOpenProjectSessionInNewWindow,
      openRenameSessionDialog,
      queryClient,
      toggleSessionPin,
      toggleSessionUnread,
    ],
  );

  const openSessionContextMenu = useCallback(
    async (session: ProjectSessionDomain, event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const [sections, directSectionId, availableOpeners] = await Promise.all([
        listAllSidebarSections().catch(() => []),
        invoke("sidebar-sections:item:placement", {
          kind: "session",
          sessionId: session.id,
        }).catch(() => null),
        invoke("shell:file-link-openers:list-available").catch(() => []),
      ]);
      const customSections = sections.filter(
        (section) => section.kind === "custom" && section.lifecycle === "active",
      );
      const preferredOpener = readFileLinkOpener();
      const discoveredOpeners = Array.isArray(availableOpeners) ? availableOpeners : [];
      const openInIds = discoveredOpeners.includes(preferredOpener)
        ? [preferredOpener, ...discoveredOpeners.filter((id) => id !== preferredOpener)]
        : discoveredOpeners;
      const openInTargets = openInIds.flatMap((id) => {
        const option = FILE_LINK_OPENER_OPTIONS.find((candidate) => candidate.id === id);
        return option
          ? [{ id: option.id, label: option.label, iconUrl: FILE_LINK_OPENER_ICON_URLS[option.id] }]
          : [];
      });
      const items = buildSessionContextMenuItems({
        session,
        projects,
        sections: customSections,
        directSectionId,
        openInTargets,
      });

      beginContextMenu(session.id);
      try {
        const selectedId = await showNativeContextMenu(items);
        if (!selectedId) return;
        await handleSessionContextMenuAction(session, selectedId);
      } catch {
        toast.danger("Native context menu is unavailable");
      } finally {
        finishContextMenu();
      }
    },
    [beginContextMenu, finishContextMenu, handleSessionContextMenuAction, projects],
  );

  return {
    archiveSession,
    archiveSidebarThreadItem,
    archiveSidebarThreadItemQuiet,
    handlePendingWorktreeTitleDoubleClick,
    handleSessionTitleDoubleClick,
    markSidebarThreadItemRead,
    moveSidebarThreadForSidebar,
    openRenameSessionDialog,
    openSessionContextMenu,
    prefetchSidebarSession,
    refreshProjectSessions,
    resolveForkLocalEnvironmentConfigPath,
    selectProject,
    selectSession,
    selectSidebarThread,
    toggleSessionPin,
    toggleSidebarThreadPinned,
  };
}
