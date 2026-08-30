import { useCallback, useEffect, useEffectEvent, useRef, type MutableRefObject } from "react";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";
import { toast } from "@/components/ui/toast";
import { projectWorkspaceRootOrNull } from "./workbench-workspace-context";
import {
  PANEL_NEW_TAB_ACTIONS,
  isWorkbenchTabKind,
  matchesPanelActionShortcut,
  type PanelNewTabActionKind,
} from "./workbench-panel-actions";
import {
  resolveLeafIdForPanelTab,
  resolveSessionPanelActiveLeafId,
  resolveSessionPanelActiveTabId,
} from "./workbench-panel-placement";
import { isPreviewableWorkbenchTabKind } from "./workbench-panel-preview";
import { getRenderablePanelPreviewTab } from "./workbench-panel-projection";
import { resolveWorkbenchPanelCapabilities } from "./workbench-panel-capabilities";
import {
  resolveFocusedPanelTabCycleScope,
  isCodexTerminalShortcutTarget,
  isDocumentLevelShortcutTarget,
  isFocusedPanelTabShortcutTargetBlocked,
  isWorkbenchPanelTabShortcutTargetBlocked,
  isWorkbenchNewChatShortcutTargetEditable,
  type PanelTabCycleScope,
} from "./workbench-panel-shortcut-scope";
import {
  resolveNextPanelTabId,
  resolvePanelTabCloseShortcut,
  resolvePanelTabCycleDirection,
  type PanelTabCycleDirection,
} from "./workbench-panel-tab-cycle";
import {
  findWorkbenchPanelLeaf,
  findWorkbenchPanelLeafForTab,
} from "../../shared/workbench-panel-layout";
import {
  requireWorkbenchBrowserTabProjectionId,
  type BrowserSidebarOpenNewTabRequest,
} from "../../shared/browser-sidebar";
import type { WorkbenchPanelController } from "./use-workbench-panel-controller";
import type { useWorkbenchPanelLifecycle } from "./use-workbench-panel-lifecycle";
import type { useWorkbenchPanelOpeners } from "./use-workbench-panel-openers";
import type { useWorkbenchSessionCommands } from "./use-workbench-session-commands";
import type { WorkbenchSessionRenderProjection } from "./workbench-session-presentation";
import type { PanelDestination } from "@/components/workbench/panel-destination-picker-model";
import type { OpenPageStageOptions } from "@/components/board/open-page-stage";
import type { CommandKeymapState } from "../../shared/command-keybindings";
import type { PanelId, Project, WorkbenchTabCreateInput, WorkbenchTabProjection } from "./types";
import type {
  WorkbenchPanelTabShortcutFocus,
  WorkbenchPanelTabShortcutState,
  WorkbenchPanelTabShortcutTarget,
} from "./workbench-panel-tab-shortcut";
import { primaryCanvasBlockId } from "../../shared/block-documents";

const reloadBrowserTabCommand = defineRendererCommand({
  key: "browser.reload_tab",
  channel: "browser-sidebar-command",
  authority: "main",
  owner: "WorkbenchPanelCommandRouter",
  protocol: { kind: "returned_value" },
});

type ProjectSession = WorkbenchSessionRenderProjection;
type PanelLifecycle = Pick<
  ReturnType<typeof useWorkbenchPanelLifecycle>,
  | "activatePanelGroup"
  | "clearPanelPreviewTab"
  | "closePanelTab"
  | "ensureActivePanelOpenWithoutRefresh"
  | "pinPreviewTab"
  | "selectPanelTab"
  | "setActivePanelCollapsed"
  | "setActivePanelTab"
>;
type PanelOpeners = Pick<
  ReturnType<typeof useWorkbenchPanelOpeners>,
  "openCanvasStage" | "openPreviewTab" | "openSideChat"
>;
type SessionCommands = Pick<ReturnType<typeof useWorkbenchSessionCommands>, "createManualTab">;

interface WorkbenchPanelCommandRouterInput {
  readonly activeSession: ProjectSession | null;
  readonly activePanelOwnerKey: string | null;
  readonly projects: readonly Project[];
  readonly windowSessionId: string;
  readonly isMacPlatform: boolean;
  readonly sidePanelOpen: boolean;
  readonly bottomPanelOpen: boolean;
  readonly controller: WorkbenchPanelController;
  readonly lifecycle: PanelLifecycle;
  readonly panelOpeners: PanelOpeners;
  readonly sessionCommands: SessionCommands;
  readonly createSessionViewTab: (input: WorkbenchTabCreateInput) => WorkbenchTabProjection | null;
  readonly resolveProjectDefaultDatabaseViewId: (projectId: string | null) => string | null;
  readonly openPageStage: (
    projectId: string,
    pageId: string,
    titleSnapshot?: string,
    options?: OpenPageStageOptions,
  ) => void;
  readonly commandKeymapState?: CommandKeymapState | null;
  readonly focusedPanelGroupRef: MutableRefObject<WorkbenchPanelTabShortcutFocus | null>;
  readonly panelTabShortcutStateRef: MutableRefObject<WorkbenchPanelTabShortcutState | null>;
}

function findDbViewTabForProject(
  session: ProjectSession,
  projectId: string,
): WorkbenchTabProjection | null {
  return (
    session.tabs.find(
      (tab) =>
        tab.kind === "db_view" && "projectId" in tab.config && tab.config.projectId === projectId,
    ) ?? null
  );
}

function findDbViewTabForDatabaseView(
  session: ProjectSession,
  projectId: string,
  databaseViewId: string,
): WorkbenchTabProjection | null {
  return (
    session.tabs.find(
      (tab) =>
        tab.kind === "db_view" &&
        "projectId" in tab.config &&
        tab.config.projectId === projectId &&
        "databaseViewId" in tab.config &&
        tab.config.databaseViewId === databaseViewId,
    ) ?? null
  );
}

/**
 * Owns panel feature commands, picker destinations, tab cycling, and the
 * document-level panel shortcut Adapter.
 */
export function useWorkbenchPanelCommandRouter({
  activeSession,
  activePanelOwnerKey,
  projects,
  windowSessionId,
  isMacPlatform,
  sidePanelOpen,
  bottomPanelOpen,
  controller,
  lifecycle,
  panelOpeners,
  sessionCommands,
  createSessionViewTab,
  resolveProjectDefaultDatabaseViewId,
  openPageStage,
  commandKeymapState,
  focusedPanelGroupRef,
  panelTabShortcutStateRef,
}: WorkbenchPanelCommandRouterInput) {
  const panelControllerRef = useRef(controller);
  panelControllerRef.current = controller;
  const { previewTabsByPanel } = controller;
  const {
    activatePanelGroup,
    clearPanelPreviewTab,
    ensureActivePanelOpenWithoutRefresh,
    pinPreviewTab,
    setActivePanelCollapsed,
    setActivePanelTab,
  } = lifecycle;
  const { openCanvasStage, openPreviewTab, openSideChat } = panelOpeners;
  const { createManualTab } = sessionCommands;

  const createBrowserTabToRight = useCallback(
    async (
      sourceTab: WorkbenchTabProjection,
      duplicate: boolean,
      openRequest?: BrowserSidebarOpenNewTabRequest,
    ) => {
      if (!activeSession) return;
      const sessionProjectId = activeSession.projectId;
      const panelId = sourceTab.panelId;
      const sourceLeaf = findWorkbenchPanelLeafForTab(
        activeSession.panels[panelId].layout,
        sourceTab.id,
      );
      if (!sourceLeaf) return;
      const sourceIndex = sourceLeaf.tabIds.indexOf(sourceTab.id);
      const sourceConfig =
        sourceTab.kind === "browser" && "projectId" in sourceTab.config
          ? sourceTab.config
          : { projectId: sessionProjectId };
      const created = createSessionViewTab({
        sessionId: activeSession.id,
        panelId,
        presentation: openRequest?.background ? "background" : "activate",
        targetLeafId: sourceLeaf.id,
        targetIndex: sourceIndex + 1,
        openerTabId: sourceTab.id,
        kind: "browser",
        title: duplicate
          ? sourceTab.title || "Browser"
          : openRequest?.url === "about:blank"
            ? "Browser"
            : (openRequest?.url ?? "Browser"),
        config: duplicate
          ? {
              projectId: sessionProjectId,
              ...("url" in sourceConfig && typeof sourceConfig.url === "string"
                ? { url: sourceConfig.url }
                : {}),
              ...("title" in sourceConfig && typeof sourceConfig.title === "string"
                ? { title: sourceConfig.title }
                : {}),
              ...("faviconUrl" in sourceConfig && typeof sourceConfig.faviconUrl === "string"
                ? { faviconUrl: sourceConfig.faviconUrl }
                : {}),
              ...("deviceToolbarVisible" in sourceConfig &&
              typeof sourceConfig.deviceToolbarVisible === "boolean"
                ? { deviceToolbarVisible: sourceConfig.deviceToolbarVisible }
                : {}),
            }
          : {
              projectId: sessionProjectId,
              ...(openRequest ? { url: openRequest.url } : {}),
            },
      });
      if (!created) return;
      if (!openRequest?.background) {
        await setActivePanelTab(panelId, created.id, { openPanel: true, leafId: sourceLeaf.id });
      }
    },
    [activeSession, createSessionViewTab, setActivePanelTab],
  );

  const reloadBrowserTab = useCallback(
    (tab: WorkbenchTabProjection) => {
      if (!activeSession || tab.kind !== "browser") return;
      void invokePlainCommand(reloadBrowserTabCommand, {
        type: "reload",
        browserConversationId: activeSession.id,
        browserViewScopeId: windowSessionId,
        browserTabId: requireWorkbenchBrowserTabProjectionId(tab),
      });
    },
    [activeSession, windowSessionId],
  );

  const focusOrCreateSessionTerminalTab = useCallback(async () => {
    if (!activeSession) return;
    const focusedScope =
      typeof document === "undefined"
        ? null
        : resolveFocusedPanelTabCycleScope(document.activeElement);
    const targetScope = focusedScope ?? focusedPanelGroupRef.current;
    const targetPanelId = targetScope?.panelId ?? "bottom";
    const targetLeafId =
      targetScope?.leafId ?? resolveSessionPanelActiveLeafId(activeSession, targetPanelId);
    const targetPanelOpen = targetPanelId === "right" ? sidePanelOpen : bottomPanelOpen;
    const targetLeaf = findWorkbenchPanelLeaf(
      activeSession.panels[targetPanelId].layout,
      targetLeafId,
    );
    const activeTabId =
      targetLeaf?.activeTabId ?? resolveSessionPanelActiveTabId(activeSession, targetPanelId);
    const activeTab = activeTabId
      ? (activeSession.tabs.find((tab) => tab.id === activeTabId) ?? null)
      : null;

    if (targetPanelOpen && activeTab?.kind === "terminal") {
      await setActivePanelCollapsed(targetPanelId, true);
      return;
    }

    const terminalInTargetLeaf = activeSession.tabs.find(
      (tab) =>
        tab.kind === "terminal" &&
        tab.panelId === targetPanelId &&
        resolveLeafIdForPanelTab(activeSession, targetPanelId, tab.id) === targetLeafId,
    );
    const terminalInTargetPanel = activeSession.tabs.find(
      (tab) => tab.kind === "terminal" && tab.panelId === targetPanelId,
    );
    const existing =
      terminalInTargetLeaf ??
      terminalInTargetPanel ??
      activeSession.tabs.find((tab) => tab.kind === "terminal" && tab.panelId === "bottom") ??
      activeSession.tabs.find((tab) => tab.kind === "terminal");

    if (existing) {
      await setActivePanelTab(existing.panelId, existing.id, {
        openPanel: true,
        leafId: resolveLeafIdForPanelTab(activeSession, existing.panelId, existing.id),
      });
      return;
    }

    await createManualTab("terminal", targetPanelId, targetLeafId);
  }, [
    activeSession,
    bottomPanelOpen,
    createManualTab,
    focusedPanelGroupRef,
    setActivePanelCollapsed,
    setActivePanelTab,
    sidePanelOpen,
  ]);

  const openDbViewFromPanelPicker = useCallback(
    async (projectId: string, databaseViewId: string, panelId: PanelId, leafId: string) => {
      if (!activeSession || activeSession.projectId === null) return;
      const existing = findDbViewTabForDatabaseView(activeSession, projectId, databaseViewId);
      if (existing) {
        const existingLeafId = resolveLeafIdForPanelTab(
          activeSession,
          existing.panelId,
          existing.id,
        );
        await setActivePanelTab(existing.panelId, existing.id, {
          leafId: existingLeafId,
          openPanel: true,
        });
        return;
      }

      createSessionViewTab({
        sessionId: activeSession.id,
        panelId,
        targetLeafId: leafId,
        kind: "db_view",
        title: "DB View",
        config: { projectId, databaseViewId },
      });
      await ensureActivePanelOpenWithoutRefresh(panelId);
    },
    [activeSession, createSessionViewTab, ensureActivePanelOpenWithoutRefresh, setActivePanelTab],
  );

  const openPageStageFromPanelPicker = useCallback(
    async (
      destination: Extract<PanelDestination, { kind: "page" }>,
      panelId: PanelId,
      leafId: string,
    ) => {
      if (!activeSession || activeSession.projectId === null) {
        openPageStage(destination.projectId, destination.pageId, destination.titleSnapshot);
        return;
      }

      const existing = activeSession.tabs.find(
        (tab) =>
          tab.kind === "page_stage" &&
          tab.panelId === panelId &&
          "pageId" in tab.config &&
          tab.config.pageId === destination.pageId &&
          tab.config.projectId === destination.projectId,
      );
      if (existing) {
        const existingLeafId = resolveLeafIdForPanelTab(activeSession, panelId, existing.id);
        clearPanelPreviewTab(activeSession.id, panelId, existingLeafId);
        await setActivePanelTab(panelId, existing.id, { leafId: existingLeafId, openPanel: true });
        return;
      }

      const matchingPreviewTab = getRenderablePanelPreviewTab(
        activeSession,
        panelId,
        leafId,
        previewTabsByPanel,
      );
      if (
        matchingPreviewTab?.kind === "page_stage" &&
        "pageId" in matchingPreviewTab.config &&
        matchingPreviewTab.config.pageId === destination.pageId &&
        matchingPreviewTab.config.projectId === destination.projectId
      ) {
        await pinPreviewTab(panelId, matchingPreviewTab.id, leafId);
        return;
      }

      createSessionViewTab({
        sessionId: activeSession.id,
        panelId,
        targetLeafId: leafId,
        kind: "page_stage",
        title: destination.titleSnapshot || destination.pageId,
        config: {
          projectId: destination.projectId,
          pageId: destination.pageId,
          titleSnapshot: destination.titleSnapshot || destination.pageId,
        },
      });
      await ensureActivePanelOpenWithoutRefresh(panelId);
    },
    [
      activeSession,
      clearPanelPreviewTab,
      createSessionViewTab,
      ensureActivePanelOpenWithoutRefresh,
      openPageStage,
      pinPreviewTab,
      previewTabsByPanel,
      setActivePanelTab,
    ],
  );

  const openPanelDestinationFromPicker = useCallback(
    async (destination: PanelDestination, panelId: PanelId, leafId: string) => {
      await activatePanelGroup(panelId, leafId);
      if (destination.kind === "db") {
        await openDbViewFromPanelPicker(
          destination.projectId,
          destination.databaseViewId,
          panelId,
          leafId,
        );
        return;
      }

      await openPageStageFromPanelPicker(destination, panelId, leafId);
    },
    [activatePanelGroup, openPageStageFromPanelPicker, openDbViewFromPanelPicker],
  );

  const resolveActivePanelCapabilities = useCallback(
    (panelId: PanelId) => {
      const project =
        activeSession?.projectId === null
          ? null
          : (projects.find((candidate) => candidate.id === activeSession?.projectId) ?? null);
      return resolveWorkbenchPanelCapabilities({
        panelId,
        owner: activeSession
          ? {
              kind: "session",
              projectId: activeSession.projectId,
              hasAttachedThread: Boolean(activeSession.thread),
              cwd: activeSession.thread?.cwd,
              projectWorkspaceRoot: projectWorkspaceRootOrNull(project),
            }
          : null,
        existingTabKinds: activeSession?.tabs.map((tab) => tab.kind) ?? [],
      });
    },
    [activeSession, projects],
  );

  const focusOrCreateDatabaseViewTab = useCallback(
    async (
      databaseViewId: string,
      targetPanelId: PanelId,
      targetLeafId?: string,
    ): Promise<boolean> => {
      if (!activeSession || activeSession.projectId === null) return false;
      const projectId = activeSession.projectId;
      const existing = findDbViewTabForDatabaseView(activeSession, projectId, databaseViewId);
      if (existing) {
        await setActivePanelTab(existing.panelId, existing.id, {
          leafId: resolveLeafIdForPanelTab(activeSession, existing.panelId, existing.id),
          openPanel: true,
        });
        return true;
      }
      createSessionViewTab({
        sessionId: activeSession.id,
        panelId: targetPanelId,
        ...(targetLeafId ? { targetLeafId } : {}),
        kind: "db_view",
        title: "DB View",
        config: { projectId, databaseViewId },
      });
      await ensureActivePanelOpenWithoutRefresh(targetPanelId);
      return true;
    },
    [activeSession, createSessionViewTab, ensureActivePanelOpenWithoutRefresh, setActivePanelTab],
  );

  const focusOrCreateProjectDbViewTab = useCallback(
    async (targetPanelId: PanelId, targetLeafId?: string): Promise<boolean> => {
      if (!activeSession || activeSession.projectId === null) return false;
      const projectId = activeSession.projectId;
      const existing = findDbViewTabForProject(activeSession, projectId);
      if (existing) {
        await setActivePanelTab(existing.panelId, existing.id, {
          leafId: resolveLeafIdForPanelTab(activeSession, existing.panelId, existing.id),
          openPanel: true,
        });
        return true;
      }
      const databaseViewId = resolveProjectDefaultDatabaseViewId(projectId);
      if (!databaseViewId) {
        toast.danger("This project's Database has no default View to open.");
        return false;
      }
      return await focusOrCreateDatabaseViewTab(databaseViewId, targetPanelId, targetLeafId);
    },
    [
      activeSession,
      focusOrCreateDatabaseViewTab,
      resolveProjectDefaultDatabaseViewId,
      setActivePanelTab,
    ],
  );

  const dispatchPanelAction = useCallback(
    async (
      kind: PanelNewTabActionKind,
      options: {
        panelId?: PanelId;
        leafId?: string;
        terminalBehavior?: "create" | "focus_or_create";
      } = {},
    ): Promise<boolean> => {
      const action = PANEL_NEW_TAB_ACTIONS.find((candidate) => candidate.kind === kind);
      const panelId = options.panelId ?? action?.defaultPanelId ?? "right";
      if (!resolveActivePanelCapabilities(panelId).actions[kind].available) return false;

      if (kind === "side_chat") {
        await openSideChat({ targetPanelId: panelId, targetLeafId: options.leafId });
        return true;
      }
      if (kind === "terminal" && options.terminalBehavior === "focus_or_create") {
        await focusOrCreateSessionTerminalTab();
        return true;
      }
      if (kind === "db_view") {
        return await focusOrCreateProjectDbViewTab(panelId, options.leafId);
      }
      if (kind === "canvas_stage") {
        if (!activeSession?.projectId) return false;
        return await openCanvasStage(
          activeSession.projectId,
          primaryCanvasBlockId(activeSession.projectId),
          "Canvas",
          {
            targetPanelId: panelId,
            targetLeafId: options.leafId,
          },
        );
      }
      if (!isWorkbenchTabKind(kind)) return false;
      if (kind === "files") {
        return await createManualTab(kind, panelId, options.leafId);
      }
      if (isPreviewableWorkbenchTabKind(kind)) {
        await openPreviewTab(kind, panelId, options.leafId);
        return true;
      }
      return await createManualTab(kind, panelId, options.leafId);
    },
    [
      activeSession?.projectId,
      createManualTab,
      focusOrCreateProjectDbViewTab,
      focusOrCreateSessionTerminalTab,
      openCanvasStage,
      openPreviewTab,
      openSideChat,
      resolveActivePanelCapabilities,
    ],
  );

  const rememberFocusedPanelGroup = useCallback(
    (panelId: PanelId, leafId: string) => {
      if (!activePanelOwnerKey) {
        focusedPanelGroupRef.current = null;
        return;
      }
      focusedPanelGroupRef.current = { panelId, leafId, ownerKey: activePanelOwnerKey };
    },
    [activePanelOwnerKey, focusedPanelGroupRef],
  );

  const resolvePanelShortcutScope = useCallback(
    (scope: PanelTabCycleScope | null): WorkbenchPanelTabShortcutFocus | null => {
      const state = panelTabShortcutStateRef.current;
      if (!state || !activePanelOwnerKey || state.ownerKey !== activePanelOwnerKey) {
        return null;
      }
      if (scope) return { ...scope, ownerKey: activePanelOwnerKey };
      const focusedScope = focusedPanelGroupRef.current;
      if (focusedScope?.ownerKey !== activePanelOwnerKey) return null;
      return focusedScope;
    },
    [activePanelOwnerKey, focusedPanelGroupRef, panelTabShortcutStateRef],
  );

  useEffect(() => {
    focusedPanelGroupRef.current = null;
  }, [activePanelOwnerKey, focusedPanelGroupRef]);

  const cycleFocusedPanelTab = useCallback(
    (
      direction: PanelTabCycleDirection,
      scope: PanelTabCycleScope | null,
      options: { respectActiveElementGuard?: boolean } = {},
    ): boolean => {
      if (
        options.respectActiveElementGuard &&
        typeof document !== "undefined" &&
        isWorkbenchPanelTabShortcutTargetBlocked(document.activeElement)
      ) {
        return false;
      }

      const targetScope = resolvePanelShortcutScope(scope);
      if (!targetScope) return false;

      const state = panelTabShortcutStateRef.current;
      if (!state) return false;
      const panelTabs = state.projection[targetScope.panelId];
      if (!(targetScope.leafId in panelTabs.itemsByLeafId)) return false;

      const tabs = panelTabs.itemsByLeafId[targetScope.leafId] ?? [];
      const activeTabId = panelTabs.activeTabIdsByLeafId[targetScope.leafId] ?? null;
      const nextTabId = resolveNextPanelTabId(tabs, activeTabId, direction);
      if (nextTabId) {
        const target: WorkbenchPanelTabShortcutTarget = {
          panelId: targetScope.panelId,
          tabId: nextTabId,
          leafId: targetScope.leafId,
        };
        void state.selectTab(target);
      }
      return true;
    },
    [panelTabShortcutStateRef, resolvePanelShortcutScope],
  );

  const closeFocusedPanelTab = useCallback(
    (
      scope: PanelTabCycleScope | null,
      options: { respectActiveElementGuard?: boolean } = {},
    ): boolean => {
      if (
        options.respectActiveElementGuard &&
        typeof document !== "undefined" &&
        isWorkbenchPanelTabShortcutTargetBlocked(document.activeElement)
      ) {
        return false;
      }

      const targetScope = resolvePanelShortcutScope(scope);
      if (!targetScope) return false;

      const state = panelTabShortcutStateRef.current;
      if (!state) return false;
      const panelTabs = state.projection[targetScope.panelId];
      if (!(targetScope.leafId in panelTabs.itemsByLeafId)) return false;

      const tabs = panelTabs.itemsByLeafId[targetScope.leafId] ?? [];
      const activeTabId = panelTabs.activeTabIdsByLeafId[targetScope.leafId] ?? null;
      const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
      if (activeTab?.closable === true) {
        void state.closeTab({
          panelId: targetScope.panelId,
          tabId: activeTab.id,
          leafId: targetScope.leafId,
        });
      }
      return true;
    },
    [panelTabShortcutStateRef, resolvePanelShortcutScope],
  );

  const handleRightPanelShortcut = useEffectEvent((event: KeyboardEvent): boolean => {
    if (isCodexTerminalShortcutTarget(event.target)) return false;

    const cycleDirection = resolvePanelTabCycleDirection(event, isMacPlatform, commandKeymapState);
    if (cycleDirection) {
      if (isFocusedPanelTabShortcutTargetBlocked(event.target)) return false;
      const scope = resolveFocusedPanelTabCycleScope(event.target);
      if (scope) {
        rememberFocusedPanelGroup(scope.panelId, scope.leafId);
        return cycleFocusedPanelTab(cycleDirection, scope);
      }
      if (!isDocumentLevelShortcutTarget(event.target)) return false;
      return cycleFocusedPanelTab(cycleDirection, null);
    }

    if (resolvePanelTabCloseShortcut(event, isMacPlatform, commandKeymapState)) {
      if (isFocusedPanelTabShortcutTargetBlocked(event.target)) return false;
      const scope = resolveFocusedPanelTabCycleScope(event.target);
      if (scope) {
        rememberFocusedPanelGroup(scope.panelId, scope.leafId);
        return closeFocusedPanelTab(scope);
      }
      if (!isDocumentLevelShortcutTarget(event.target)) return false;
      return closeFocusedPanelTab(null);
    }

    if (isWorkbenchNewChatShortcutTargetEditable(event.target)) return false;

    if (!activeSession) return false;

    const action = PANEL_NEW_TAB_ACTIONS.find((candidate) =>
      matchesPanelActionShortcut(event, candidate, isMacPlatform, commandKeymapState),
    );
    if (!action) return false;
    if (!resolveActivePanelCapabilities(action.defaultPanelId).actions[action.kind].available) {
      return false;
    }
    void dispatchPanelAction(action.kind, {
      panelId: action.defaultPanelId,
      terminalBehavior: "focus_or_create",
    });
    return true;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!handleRightPanelShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return {
    createBrowserTabToRight,
    reloadBrowserTab,
    openPanelDestinationFromPicker,
    resolveActivePanelCapabilities,
    focusOrCreateProjectDbViewTab,
    focusOrCreateDatabaseViewTab,
    dispatchPanelAction,
    rememberFocusedPanelGroup,
    cycleFocusedPanelTab,
    closeFocusedPanelTab,
  };
}
