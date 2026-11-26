import { beginWorkbenchFocus, panelTabFocusTarget } from "./workbench-focus-landing";
import { useWorkbenchWindowOwner } from "./use-workbench-window-state";
import { readWorkbenchAgentContext } from "./workbench-agent-context";
import { getIntl } from "@/lib/i18n";
import { handleContentSearchNavigationShortcut } from "@/features/content-search/content-search-keyboard";
import { resolveCodexRendererCommandPlatform } from "./codex-window-runtime";
import {
  classifyKeyboardActionSurface,
  matchesKeyboardActionCommand,
} from "./keyboard-action-runtime";
import {
  useLayoutEffect,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  type MutableRefObject,
} from "react";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";
import { toast } from "@/components/ui/toast";
import { requestTerminalFocus, returnFocusFromPanel } from "./terminal-focus";
import { projectWorkspaceRootOrNull, sessionPanelOwner } from "./workbench-workspace-context";
import {
  PANEL_NEW_TAB_ACTIONS,
  getPanelNewTabAction,
  isWorkbenchTabKind,
  matchesPanelActionShortcut,
  type PanelNewTabActionKind,
} from "./workbench-panel-actions";
import {
  resolveLeafIdForPanelTab,
  resolveSessionPanelActiveLeafId,
  resolveSessionPanelActiveTabId,
} from "./workbench-panel-placement";
import { getRenderablePanelPreviewTab } from "./workbench-panel-projection";
import { resolveWorkbenchPanelCapabilities } from "./workbench-panel-capabilities";
import {
  resolveFocusedPanelTabCycleScope,
  focusBrowserAddressBar,
  isDocumentLevelShortcutTarget,
  isWorkbenchPanelTabShortcutTargetBlocked,
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
import { resolveBrowserTabTitle } from "../../shared/browser-url";
import { requireWorkbenchBrowserTabProjectionId } from "../../shared/browser-sidebar";
import type { WorkbenchPanelController } from "./use-workbench-panel-controller";
import type { useWorkbenchPanelLifecycle } from "./use-workbench-panel-lifecycle";
import type { useWorkbenchPanelOpeners } from "./use-workbench-panel-openers";
import type { useWorkbenchSessionCommands } from "./use-workbench-session-commands";
import type { WorkbenchSessionRenderProjection } from "./workbench-session-presentation";
import type { PanelDestination } from "@/components/workbench/panel-destination-picker-model";
import type { OpenPageStageOptions } from "@/components/board/open-page-stage";
import {
  createCommandKeymapState,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
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

const TERMINAL_ACTION = getPanelNewTabAction("terminal");

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
  "openCanvasStage" | "openSideChat"
>;
type SessionCommands = Pick<ReturnType<typeof useWorkbenchSessionCommands>, "createManualTab">;

interface WorkbenchPanelCommandRouterInput {
  readonly activeSession: ProjectSession | null;
  readonly activePanelOwnerKey: string | null;
  readonly activeProjectSceneId: string | null;
  readonly openProjectScenePanelAction: (
    projectId: string,
    action: PanelNewTabActionKind,
    placement: { panelId: PanelId; leafId?: string },
  ) => Promise<boolean>;
  readonly projects: readonly Project[];
  readonly windowSessionId: string;
  readonly sidePanelOpen: boolean;
  readonly bottomPanelOpen: boolean;
  readonly controller: WorkbenchPanelController;
  readonly lifecycle: PanelLifecycle;
  readonly panelOpeners: PanelOpeners;
  readonly sessionCommands: SessionCommands;
  readonly createSessionViewTab: (
    input: WorkbenchTabCreateInput,
  ) => Promise<WorkbenchTabProjection | null>;
  readonly resolveProjectDefaultDatabaseViewId: (projectId: string | null) => string | null;
  readonly openLibraryPage: (
    pageId: string,
    titleSnapshot: string,
    panelId: PanelId,
    leafId: string,
  ) => Promise<void>;
  readonly openPageStage: (
    projectId: string,
    pageId: string,
    titleSnapshot?: string,
    options?: OpenPageStageOptions,
  ) => void;
  readonly openAgentsTab: import("./workbench-agents-tab").OpenOrFocusAgentsTab;
  readonly commandKeymapState?: CommandKeymapState | null;
  /** Creates a Space Page and opens it in the panel group. */
  readonly openNewPage: (placement: {
    readonly panelId: PanelId;
    readonly leafId?: string;
  }) => Promise<boolean>;
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
        tab.kind === "db_view" &&
        tab.config.routingContext.kind === "project" &&
        tab.config.routingContext.projectId === projectId,
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
        tab.config.routingContext.kind === "project" &&
        tab.config.routingContext.projectId === projectId &&
        tab.config.target.kind === "database-view" &&
        tab.config.target.databaseViewId === databaseViewId,
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
  activeProjectSceneId,
  openProjectScenePanelAction,
  projects,
  windowSessionId,
  sidePanelOpen,
  bottomPanelOpen,
  controller,
  lifecycle,
  panelOpeners,
  sessionCommands,
  createSessionViewTab,
  resolveProjectDefaultDatabaseViewId,
  openPageStage,
  openLibraryPage,
  commandKeymapState,
  openNewPage,
  openAgentsTab,
  focusedPanelGroupRef,
  panelTabShortcutStateRef,
}: WorkbenchPanelCommandRouterInput) {
  const windowOwner = useWorkbenchWindowOwner();
  const { landOnScene, focusLanding } = windowOwner;
  const panelControllerRef = useRef(controller);
  useLayoutEffect(() => {
    panelControllerRef.current = controller;
  }, [controller]);
  const { previewTabsByPanel } = controller;
  const {
    activatePanelGroup,
    clearPanelPreviewTab,
    ensureActivePanelOpenWithoutRefresh,
    pinPreviewTab,
    setActivePanelCollapsed,
    setActivePanelTab,
  } = lifecycle;
  const { openCanvasStage, openSideChat } = panelOpeners;
  const { createManualTab } = sessionCommands;

  const createBrowserTabToRight = useCallback(
    async (sourceTab: WorkbenchTabProjection, duplicate: boolean) => {
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
      const created = await createSessionViewTab({
        sessionId: activeSession.id,
        panelId,
        targetLeafId: sourceLeaf.id,
        targetIndex: sourceIndex + 1,
        openerTabId: sourceTab.id,
        kind: "browser",
        title: duplicate
          ? sourceTab.title || resolveBrowserTabTitle(undefined, undefined)
          : resolveBrowserTabTitle(undefined, undefined),
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
          : { projectId: sessionProjectId },
      });
      if (!created) return;
      await setActivePanelTab(panelId, created.id, { openPanel: true, leafId: sourceLeaf.id });
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
      returnFocusFromPanel(targetPanelId, (attempt) => landOnScene("composer", attempt));
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
      requestTerminalFocus(existing);
      return;
    }

    await createManualTab("terminal", targetPanelId, targetLeafId);
  }, [
    activeSession,
    bottomPanelOpen,
    createManualTab,
    focusedPanelGroupRef,
    landOnScene,
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

      await createSessionViewTab({
        sessionId: activeSession.id,
        panelId,
        targetLeafId: leafId,
        kind: "db_view",
        title: "DB View",
        config: {
          routingContext: { kind: "project", projectId },
          target: { kind: "database-view", databaseViewId },
        },
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
      if (destination.projectId === null) {
        await openLibraryPage(destination.pageId, destination.titleSnapshot, panelId, leafId);
        return;
      }
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
          tab.config.routingContext.kind === "project" &&
          tab.config.routingContext.projectId === destination.projectId,
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
        matchingPreviewTab.config.routingContext.kind === "project" &&
        matchingPreviewTab.config.routingContext.projectId === destination.projectId
      ) {
        await pinPreviewTab(panelId, matchingPreviewTab.id, leafId);
        return;
      }

      await createSessionViewTab({
        sessionId: activeSession.id,
        panelId,
        targetLeafId: leafId,
        kind: "page_stage",
        title: destination.titleSnapshot || destination.pageId,
        config: {
          routingContext: { kind: "project", projectId: destination.projectId },
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
      openLibraryPage,
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
        owner: activeSession ? sessionPanelOwner(activeSession, project) : null,
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
      await createSessionViewTab({
        sessionId: activeSession.id,
        panelId: targetPanelId,
        ...(targetLeafId ? { targetLeafId } : {}),
        kind: "db_view",
        title: "DB View",
        config: {
          routingContext: { kind: "project", projectId },
          target: { kind: "database-view", databaseViewId },
        },
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
        toast.danger(
          getIntl().formatMessage({
            id: "lib.useWorkbenchPanelCommandRouter.toast.missingDefaultView",
            defaultMessage: "This project's Database has no default View to open.",
          }),
        );
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

      if (kind === "agents") return await openAgentsTab({ panelId, leafId: options.leafId });
      if (kind === "side_chat") {
        await openSideChat({ targetPanelId: panelId, targetLeafId: options.leafId });
        return true;
      }
      if (kind === "new_page") {
        return await openNewPage({ panelId, leafId: options.leafId });
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
      // Browser opens as a durable New tab, never as a preview another open replaces.
      return await createManualTab(kind, panelId, options.leafId);
    },
    [
      activeSession,
      createManualTab,
      focusOrCreateProjectDbViewTab,
      focusOrCreateSessionTerminalTab,
      openCanvasStage,
      openAgentsTab,
      openNewPage,
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
        const focus = beginWorkbenchFocus();
        const location = windowOwner.read().windowState.location;
        void Promise.resolve(state.selectTab(target)).then(() => {
          if (windowOwner.read().windowState.location !== location) return;
          focusLanding.request(
            panelTabFocusTarget(state.ownerKey, target.panelId, target.leafId, target.tabId),
            focus,
          );
        });
      }
      return true;
    },
    [focusLanding, panelTabShortcutStateRef, resolvePanelShortcutScope, windowOwner],
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
        const focus = beginWorkbenchFocus();
        const location = windowOwner.read().windowState.location;
        const { panelId, leafId, ownerKey } = targetScope;
        const previous = windowOwner.read();
        void Promise.resolve(state.closeTab({ panelId, tabId: activeTab.id, leafId })).then(() => {
          const next = windowOwner.read();
          if (next === previous || next.windowState.location !== location) return;
          const owner = next.windowState.scenesByOwnerKey[ownerKey]?.owner;
          const group =
            owner &&
            readWorkbenchAgentContext(next, owner)?.groups.find(
              (candidate) =>
                candidate.panelId === panelId && candidate.groupId === leafId && candidate.visible,
            );
          const tabId = group && group.selectedTabId;
          if (tabId)
            focusLanding.request(panelTabFocusTarget(ownerKey, panelId, leafId, tabId), focus);
          else landOnScene("composer", focus);
        });
      }
      return true;
    },
    [focusLanding, landOnScene, panelTabShortcutStateRef, resolvePanelShortcutScope, windowOwner],
  );

  const focusActiveBrowserAddress = useCallback((): boolean => {
    if (!activePanelOwnerKey) return false;
    return focusBrowserAddressBar(document, resolvePanelShortcutScope(null));
  }, [activePanelOwnerKey, resolvePanelShortcutScope]);

  const keymap =
    commandKeymapState ?? createCommandKeymapState({}, resolveCodexRendererCommandPlatform());

  const handlePanelNewTabShortcut = (event: KeyboardEvent, keymap: CommandKeymapState): boolean => {
    const action = PANEL_NEW_TAB_ACTIONS.find((candidate) =>
      matchesPanelActionShortcut(event, candidate, keymap),
    );
    if (!action) return false;
    if (handleContentSearchNavigationShortcut(event, keymap.platform)) return true;

    const browserScope =
      action.kind === "browser" ? resolveFocusedPanelTabCycleScope(event.target) : null;
    const panelId = browserScope?.panelId ?? action.defaultPanelId;
    const leafId = browserScope?.leafId;
    // The Terminal toggle targets a Session Terminal; Project Scenes can create one from New tab.
    if (action.kind !== "terminal" && activeProjectSceneId) {
      const project = projects.find((candidate) => candidate.id === activeProjectSceneId);
      const capabilities = resolveWorkbenchPanelCapabilities({
        panelId,
        owner: {
          kind: "project",
          projectId: activeProjectSceneId,
          projectWorkspaceRoot: projectWorkspaceRootOrNull(project),
        },
      });
      if (!capabilities.actions[action.kind].available) return false;
      void openProjectScenePanelAction(activeProjectSceneId, action.kind, { panelId, leafId });
      return true;
    }

    const capability = resolveActivePanelCapabilities(panelId).actions[action.kind];
    if (action.kind === "review" && capability.reason === "singleton_exists") {
      void createManualTab("review", panelId, leafId);
      return true;
    }
    if (!capability.available) return false;
    void dispatchPanelAction(action.kind, {
      panelId,
      leafId,
      terminalBehavior: "focus_or_create",
    });
    return true;
  };

  const handlePanelShortcut = useEffectEvent((event: KeyboardEvent): boolean => {
    if (matchesKeyboardActionCommand(event, keymap, "focusBrowserAddressBar")) {
      return focusActiveBrowserAddress();
    }

    const direction = resolvePanelTabCycleDirection(event, keymap);
    const close = resolvePanelTabCloseShortcut(event, keymap);
    if (direction || close) {
      const scope = resolveFocusedPanelTabCycleScope(event.target);
      if (scope) rememberFocusedPanelGroup(scope.panelId, scope.leafId);
      if (!scope && !isDocumentLevelShortcutTarget(event.target)) return false;
      return direction ? cycleFocusedPanelTab(direction, scope) : closeFocusedPanelTab(scope);
    }

    return handlePanelNewTabShortcut(event, keymap);
  });

  const handleTerminalShortcut = useEffectEvent((event: KeyboardEvent): boolean => {
    if (classifyKeyboardActionSurface(event) !== "terminal") return false;
    if (!matchesPanelActionShortcut(event, TERMINAL_ACTION, keymap)) return false;
    return handlePanelNewTabShortcut(event, keymap);
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (handlePanelShortcut(event)) event.preventDefault();
    };

    // xterm owns its input. Claim the explicitly reserved toggle before xterm reads it.
    const onTerminalKeyDown = (event: KeyboardEvent) => {
      if (!handleTerminalShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onTerminalKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onTerminalKeyDown, true);
    };
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
    focusActiveBrowserAddress,
  };
}
