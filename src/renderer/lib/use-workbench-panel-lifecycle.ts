import { useCallback, useEffect, useEffectEvent, useRef, type MutableRefObject } from "react";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";
import { toast } from "@/components/ui/toast";
import {
  materializeWorkbenchImageEditorSurfaceConfig,
  trackImageEditorPinOutcome,
} from "@/features/user-attachment-image-editor";
import { terminalSessionStore } from "./terminal-session-store";
import { workspaceTextDocumentRegistry } from "@/features/workspace-files/workspace-text-document-controller";
import { makeEditorSurfaceKey, documentSessionRegistry } from "./document-session-registry";
import {
  canvasSceneSurfaceRegistry,
  makeCanvasSceneSurfaceKey,
} from "./canvas-scene-surface-runtime";
import {
  closeDurablePanelTabWithRuntime,
  closePreviewPanelTabWithRuntime,
} from "./workbench-panel-runtime-lifecycle";
import { getRenderablePanelPreviewTab } from "./workbench-panel-projection";
import {
  resolveLeafIdForPanelTab,
  resolveSessionPanelActiveLeafId,
} from "./workbench-panel-placement";
import { resolvePanelTabCloseReplacement } from "./panel-tab-close-routing";
import {
  findWorkbenchPanelLeaf,
  listWorkbenchPanelLeaves,
} from "../../shared/workbench-panel-layout";
import { makeWorkbenchSessionPanelSlotKey } from "./workbench-panel-slot-key";
import { resolveSameLeafInsertionIndex } from "@/components/workbench/panel-tab-dnd";
import { makePinnedPreviewTabCreateInput } from "./workbench-panel-preview";
import { requireWorkbenchBrowserTabProjectionId } from "../../shared/browser-sidebar";
import { isSideChatPanelTab } from "./workbench-panel-tab-model";
import type { WorkbenchPanelController } from "./use-workbench-panel-controller";
import type { WorkbenchSessionRenderProjection } from "./workbench-session-presentation";
import type { useCodexAppServerControl, ThreadStageActions } from "@/features/local-conversation";
import type { AppShellTabItem } from "@/components/workbench/app-shell-tabs";
import type {
  PanelId,
  WorkbenchPanelSplitSide,
  WorkbenchTabCreateInput,
  WorkbenchTabProjection,
} from "./types";

const closeBrowserRuntimeTabCommand = defineRendererCommand({
  key: "browser.close_runtime_tab",
  channel: "browser-sidebar-command",
  authority: "main",
  owner: "WorkbenchPanelLifecycle",
  protocol: { kind: "returned_value" },
});

type ProjectSession = WorkbenchSessionRenderProjection;

interface PanelGroupTabsByPanel {
  readonly right: {
    readonly itemsByLeafId: Record<string, AppShellTabItem[]>;
    readonly activeTabIdsByLeafId: Record<string, string | null>;
  };
  readonly bottom: {
    readonly itemsByLeafId: Record<string, AppShellTabItem[]>;
    readonly activeTabIdsByLeafId: Record<string, string | null>;
  };
}

interface WorkbenchPanelLifecycleInput {
  readonly activeSession: ProjectSession | null;
  readonly controller: WorkbenchPanelController;
  readonly createSessionViewTab: (input: WorkbenchTabCreateInput) => WorkbenchTabProjection | null;
  readonly codexControl: ReturnType<typeof useCodexAppServerControl>;
  readonly panelGroupTabsRef: MutableRefObject<PanelGroupTabsByPanel>;
  readonly pinningPreviewTabIdsRef: MutableRefObject<Set<string>>;
  readonly windowSessionId: string;
}

/**
 * Owns durable and ephemeral panel selection, close, pin, move, split, and
 * runtime-release ordering. Surface renderers only receive these intents.
 */
export function useWorkbenchPanelLifecycle({
  activeSession,
  controller,
  createSessionViewTab,
  codexControl: workbenchCodexControl,
  panelGroupTabsRef,
  pinningPreviewTabIdsRef,
  windowSessionId,
}: WorkbenchPanelLifecycleInput) {
  const panelControllerRef = useRef(controller);
  panelControllerRef.current = controller;
  const {
    previewTabsByPanel,
    sideChatTabsBySession,
    mcpAppTabsBySession,
    planTabsBySession,
    automationTabsBySession,
    backgroundAgentTabsBySession,
    processOutputTabsBySession,
    imageEditorTabsBySession,
  } = controller;

  const updateSessionPanel = useCallback(
    async (
      sessionId: string,
      panelId: PanelId,
      input: Partial<ProjectSession["panels"][PanelId]>,
    ) => {
      if (!activeSession || activeSession.id !== sessionId) return null;
      panelControllerRef.current.durable.patchPanel(activeSession, panelId, {
        ...(input.collapsed === undefined ? {} : { collapsed: input.collapsed }),
        ...(input.size === undefined ? {} : { size: input.size }),
      });
      return activeSession;
    },
    [activeSession],
  );

  const updateActivePanel = useCallback(
    async (panelId: PanelId, input: Partial<ProjectSession["panels"][PanelId]>) => {
      if (!activeSession) return null;
      return updateSessionPanel(activeSession.id, panelId, input);
    },
    [activeSession, updateSessionPanel],
  );

  const setActivePanelCollapsed = useCallback(
    async (panelId: PanelId, collapsed: boolean) => {
      if (!activeSession) return null;
      const sessionId = activeSession.id;
      const overrideKey = makeWorkbenchSessionPanelSlotKey(sessionId, panelId);
      panelControllerRef.current.updatePanelCollapsedOverrides((current) => ({
        ...current,
        [overrideKey]: collapsed,
      }));

      try {
        const updated = await updateActivePanel(panelId, { collapsed });
        panelControllerRef.current.updatePanelCollapsedOverrides((current) => {
          if (!(overrideKey in current)) return current;
          const next = { ...current };
          delete next[overrideKey];
          return next;
        });
        return updated;
      } catch (error) {
        panelControllerRef.current.updatePanelCollapsedOverrides((current) => {
          if (!(overrideKey in current)) return current;
          const next = { ...current };
          delete next[overrideKey];
          return next;
        });
        toast.danger(error instanceof Error ? error.message : "Unable to update panel");
        return null;
      }
    },
    [activeSession, updateActivePanel],
  );

  const clearPanelPreviewTab = useCallback(
    (sessionId: string, panelId: PanelId, leafId?: string | null) => {
      panelControllerRef.current.updatePreviewTabsByPanel((current) => {
        const keys = leafId
          ? [
              makeWorkbenchSessionPanelSlotKey(sessionId, panelId, leafId),
              makeWorkbenchSessionPanelSlotKey(sessionId, panelId),
            ]
          : [makeWorkbenchSessionPanelSlotKey(sessionId, panelId)];
        if (!keys.some((key) => key in current)) return current;
        const next = { ...current };
        for (const key of keys) delete next[key];
        return next;
      });
    },
    [],
  );

  const setActivePanelTab = useCallback(
    async (panelId: PanelId, tabId: string, options?: { openPanel?: boolean; leafId?: string }) => {
      if (!activeSession) return;
      const leafId = options?.leafId ?? resolveLeafIdForPanelTab(activeSession, panelId, tabId);
      clearPanelPreviewTab(activeSession.id, panelId, leafId);
      panelControllerRef.current.durable.activateTab(activeSession, panelId, leafId, tabId);
      if (options?.openPanel) {
        await updateActivePanel(panelId, { collapsed: false });
      }
    },
    [activeSession, clearPanelPreviewTab, updateActivePanel],
  );

  const reorderTabs = useCallback(
    async (panelId: PanelId, tabId: string, targetIndex: number, leafId?: string) => {
      if (!activeSession) return;
      const panel = activeSession.panels[panelId];
      const leaf = leafId ? findWorkbenchPanelLeaf(panel.layout, leafId) : null;
      const order =
        leaf?.tabIds ??
        activeSession.tabs.filter((tab) => tab.panelId === panelId).map((tab) => tab.id);
      const fromIndex = order.indexOf(tabId);
      const normalizedTargetIndex = resolveSameLeafInsertionIndex({
        tabIds: order,
        sourceTabId: tabId,
        targetIndex,
      });
      if (fromIndex < 0 || normalizedTargetIndex === null) return;
      if (fromIndex === normalizedTargetIndex) return;
      const next = [...order];
      const [item] = next.splice(fromIndex, 1);
      if (!item) return;
      next.splice(normalizedTargetIndex, 0, item);
      panelControllerRef.current.durable.reorderTabs(activeSession, {
        panelId,
        leafId: leafId ?? activeSession.panels[panelId].layout.activeLeafId,
        orderedTabIds: next,
        movedTabId: tabId,
      });
    },
    [activeSession],
  );

  const getPanelVisibleLeafTabCount = useCallback(
    (panelId: PanelId, leafId: string, options: { excludingTabId?: string } = {}): number => {
      if (!activeSession) return 0;
      const excludedTabId = options.excludingTabId ?? null;
      const activeLeafId = resolveSessionPanelActiveLeafId(activeSession, panelId);
      const leaf = findWorkbenchPanelLeaf(activeSession.panels[panelId].layout, leafId);
      const durableCount = (leaf?.tabIds ?? []).filter((tabId) => {
        if (tabId === excludedTabId) return false;
        return activeSession.tabs.some((tab) => tab.id === tabId && tab.panelId === panelId);
      }).length;
      const sideChatCount = (sideChatTabsBySession[activeSession.id] ?? []).filter((tab) => {
        if (tab.id === excludedTabId) return false;
        return tab.panelId === panelId && (tab.leafId ?? activeLeafId) === leafId;
      }).length;
      const mcpAppCount = (mcpAppTabsBySession[activeSession.id] ?? []).filter((tab) => {
        if (tab.id === excludedTabId) return false;
        return tab.panelId === panelId && (tab.leafId ?? activeLeafId) === leafId;
      }).length;
      const planCount = (planTabsBySession[activeSession.id] ?? []).filter((tab) => {
        if (tab.id === excludedTabId) return false;
        return tab.panelId === panelId && (tab.leafId ?? activeLeafId) === leafId;
      }).length;
      const automationCount = (automationTabsBySession[activeSession.id] ?? []).filter((tab) => {
        if (tab.id === excludedTabId) return false;
        return tab.panelId === panelId && (tab.leafId ?? activeLeafId) === leafId;
      }).length;
      const backgroundAgentCount = (backgroundAgentTabsBySession[activeSession.id] ?? []).filter(
        (tab) => {
          if (tab.id === excludedTabId) return false;
          return tab.panelId === panelId && (tab.leafId ?? activeLeafId) === leafId;
        },
      ).length;
      const processOutputCount = (processOutputTabsBySession[activeSession.id] ?? []).filter(
        (tab) => {
          if (tab.id === excludedTabId) return false;
          return tab.panelId === panelId && (tab.leafId ?? activeLeafId) === leafId;
        },
      ).length;
      const imageEditorCount = (imageEditorTabsBySession[activeSession.id] ?? []).filter((tab) => {
        if (tab.id === excludedTabId) return false;
        return tab.panelId === panelId && (tab.leafId ?? activeLeafId) === leafId;
      }).length;
      const previewTab = getRenderablePanelPreviewTab(
        activeSession,
        panelId,
        leafId,
        previewTabsByPanel,
      );
      const previewCount = previewTab && previewTab.id !== excludedTabId ? 1 : 0;
      return (
        durableCount +
        sideChatCount +
        mcpAppCount +
        planCount +
        automationCount +
        backgroundAgentCount +
        processOutputCount +
        imageEditorCount +
        previewCount
      );
    },
    [
      activeSession,
      automationTabsBySession,
      backgroundAgentTabsBySession,
      imageEditorTabsBySession,
      mcpAppTabsBySession,
      planTabsBySession,
      processOutputTabsBySession,
      previewTabsByPanel,
      sideChatTabsBySession,
    ],
  );

  const getPanelVisibleTabCount = useCallback(
    (panelId: PanelId, options: { excludingTabId?: string } = {}): number => {
      if (!activeSession) return 0;
      return listWorkbenchPanelLeaves(activeSession.panels[panelId].layout).reduce(
        (count, leaf) => count + getPanelVisibleLeafTabCount(panelId, leaf.id, options),
        0,
      );
    },
    [activeSession, getPanelVisibleLeafTabCount],
  );

  const getPreserveEmptyLeafIdsAfterDurableRemoval = useCallback(
    (panelId: PanelId, leafId: string, tabId: string): string[] => {
      return getPanelVisibleLeafTabCount(panelId, leafId, { excludingTabId: tabId }) > 0
        ? [leafId]
        : [];
    },
    [getPanelVisibleLeafTabCount],
  );

  const removeEmptyVisiblePanelLeaf = useCallback(
    async (panelId: PanelId, leafId: string, options: { excludingTabId?: string } = {}) => {
      if (!activeSession) return;
      const leaves = listWorkbenchPanelLeaves(activeSession.panels[panelId].layout);
      if (leaves.length <= 1) return;
      if (getPanelVisibleLeafTabCount(panelId, leafId, options) > 0) return;
      panelControllerRef.current.durable.mergeLeaf(activeSession, { panelId, leafId });
    },
    [activeSession, getPanelVisibleLeafTabCount],
  );

  const resolvePanelTabCloseTarget = useCallback(
    (panelId: PanelId, tabId: string, leafId: string): string | null => {
      if (!activeSession) return null;
      const panelTabs = panelGroupTabsRef.current[panelId];
      const tabs = panelTabs.itemsByLeafId[leafId] ?? [];
      const activeTabId = panelTabs.activeTabIdsByLeafId[leafId] ?? null;
      return resolvePanelTabCloseReplacement({
        tabs,
        activeTabId,
        closingTabId: tabId,
        openerState: panelControllerRef.current.tabOpenerStore.get(
          makeWorkbenchSessionPanelSlotKey(activeSession.id, panelId, leafId),
        ),
      });
    },
    [activeSession, panelGroupTabsRef],
  );

  const activatePanelTabAfterClose = useCallback(
    async (panelId: PanelId, tabId: string | null, leafId: string) => {
      if (!activeSession || !tabId) return;
      const previewTab = getRenderablePanelPreviewTab(
        activeSession,
        panelId,
        leafId,
        previewTabsByPanel,
      );
      if (previewTab?.id === tabId) return;

      const durableTabIds = new Set(
        activeSession.tabs.filter((tab) => tab.panelId === panelId).map((tab) => tab.id),
      );
      const selected = panelControllerRef.current.selectRenderableTab({
        sessionId: activeSession.id,
        panelId,
        leafId,
        tabId,
        durableTabIds,
      });
      if (!selected || !durableTabIds.has(tabId)) return;
      await setActivePanelTab(panelId, tabId, { leafId });
    },
    [activeSession, previewTabsByPanel, setActivePanelTab],
  );

  const closeActiveSessionBrowserRuntime = useCallback(
    async (browserTabId: string) => {
      if (!activeSession) return;
      await invokePlainCommand(closeBrowserRuntimeTabCommand, {
        type: "close-tab",
        browserConversationId: activeSession.id,
        browserViewScopeId: windowSessionId,
        browserTabId,
      }).catch(() => undefined);
    },
    [activeSession, windowSessionId],
  );

  const closeTab = useCallback(
    async (
      tabId: string,
      options: {
        preserveEmptyLeafIds?: string[];
        preferredActiveLeafId?: string | null;
        preferredActiveTabId?: string | null;
      } = {},
    ) => {
      if (!activeSession) return;
      const closingTab = activeSession.tabs.find((tab) => tab.id === tabId) ?? null;
      const closingPageEditorSessionKey =
        closingTab?.kind === "page_stage"
          ? makeEditorSurfaceKey(activeSession.id, closingTab.id)
          : null;
      const deleteInput = {
        tabId,
        ...(options.preserveEmptyLeafIds && options.preserveEmptyLeafIds.length > 0
          ? { preserveEmptyLeafIds: options.preserveEmptyLeafIds }
          : {}),
        ...(options.preferredActiveLeafId !== undefined
          ? { preferredActiveLeafId: options.preferredActiveLeafId }
          : {}),
        ...(options.preferredActiveTabId !== undefined
          ? { preferredActiveTabId: options.preferredActiveTabId }
          : {}),
      };
      const result = await closeDurablePanelTabWithRuntime(closingTab, {
        flushFile: (targetTabId) => workspaceTextDocumentRegistry.flush(targetTabId),
        releaseTerminal: (terminalSessionId) => {
          terminalSessionStore.release(terminalSessionId);
        },
        removeDescriptor: () => {
          panelControllerRef.current.durable.removeTab(activeSession, tabId, {
            preserveEmptyLeafIds: deleteInput.preserveEmptyLeafIds,
            preferredActiveLeafId: deleteInput.preferredActiveLeafId,
            preferredActiveTabId: deleteInput.preferredActiveTabId,
          });
        },
        closeBrowserRuntime: closeActiveSessionBrowserRuntime,
        disposePageEditor: async () => {
          if (!closingPageEditorSessionKey) return;
          await documentSessionRegistry.dispose(closingPageEditorSessionKey);
        },
        disposeCanvas: async (tab) => {
          if (tab.kind !== "canvas_stage") return true;
          try {
            await canvasSceneSurfaceRegistry.dispose(
              makeCanvasSceneSurfaceKey(windowSessionId, activeSession.id, tab.id),
            );
            return true;
          } catch {
            return false;
          }
        },
      });
      if (result.status === "vetoed" && result.reason === "file-conflict") {
        toast.danger("Resolve the file conflict before closing this tab");
      } else if (result.status === "vetoed") {
        toast.danger("Canvas changes could not be saved locally");
      }
    },
    [activeSession, closeActiveSessionBrowserRuntime, windowSessionId],
  );

  const closeExitedTerminalTab = useEffectEvent(async (terminalSessionId: string) => {
    if (!activeSession) return;
    const tab = activeSession.tabs.find(
      (candidate) =>
        candidate.kind === "terminal" &&
        "terminalSessionId" in candidate.config &&
        candidate.config.terminalSessionId === terminalSessionId,
    );
    if (!tab) return;

    await closeTab(tab.id);
  });

  useEffect(() => {
    terminalSessionStore.ensureEventSubscriptions();
    return terminalSessionStore.subscribeExit((event) => {
      void closeExitedTerminalTab(event.sessionId);
    });
  }, []);

  const closePreviewTab = useCallback(
    async (panelId: PanelId, leafId?: string, replacementTabId: string | null = null) => {
      if (!activeSession) return;
      const targetLeafId = leafId ?? resolveSessionPanelActiveLeafId(activeSession, panelId);
      const previewTab =
        previewTabsByPanel[
          makeWorkbenchSessionPanelSlotKey(activeSession.id, panelId, targetLeafId)
        ] ??
        previewTabsByPanel[makeWorkbenchSessionPanelSlotKey(activeSession.id, panelId)] ??
        null;
      const closeResult = await closePreviewPanelTabWithRuntime(previewTab, {
        flushFile: (tabId) => workspaceTextDocumentRegistry.flush(tabId),
        isBrowserRuntimeRetained: (browserTabId) =>
          activeSession.tabs.some(
            (tab) =>
              tab.kind === "browser" &&
              requireWorkbenchBrowserTabProjectionId(tab) === browserTabId,
          ),
        closeBrowserRuntime: closeActiveSessionBrowserRuntime,
        removeDescriptor: () => {
          clearPanelPreviewTab(activeSession.id, panelId, targetLeafId);
        },
      });
      if (closeResult.status === "vetoed") {
        toast.danger("Resolve the file conflict before closing this tab");
        return;
      }
      await activatePanelTabAfterClose(panelId, replacementTabId, targetLeafId);
      if (
        previewTab &&
        getPanelVisibleLeafTabCount(panelId, targetLeafId, { excludingTabId: previewTab.id }) === 0
      ) {
        await removeEmptyVisiblePanelLeaf(panelId, targetLeafId, { excludingTabId: previewTab.id });
      }
      if (getPanelVisibleTabCount(panelId, { excludingTabId: previewTab?.id }) > 0) return;
      await updateActivePanel(panelId, { collapsed: true });
    },
    [
      activeSession,
      activatePanelTabAfterClose,
      clearPanelPreviewTab,
      closeActiveSessionBrowserRuntime,
      getPanelVisibleLeafTabCount,
      getPanelVisibleTabCount,
      previewTabsByPanel,
      removeEmptyVisiblePanelLeaf,
      updateActivePanel,
    ],
  );

  const closeEphemeralPanelTab = useCallback(
    async (
      panelId: PanelId,
      tabId: string,
      replacementTabId: string | null = null,
    ): Promise<boolean> => {
      if (!activeSession) return false;
      const fallbackLeafId = resolveSessionPanelActiveLeafId(activeSession, panelId);
      const tab = panelControllerRef.current.removeEphemeralTab({
        sessionId: activeSession.id,
        panelId,
        leafId: fallbackLeafId,
        tabId,
      });
      if (!tab) return false;
      const targetLeafId = tab.leafId ?? fallbackLeafId;

      if (isSideChatPanelTab(tab) && tab.threadId) {
        void workbenchCodexControl.discardSideChat(tab.threadId).catch((error) => {
          console.warn("[side-chat:discard]", error);
        });
      }
      await activatePanelTabAfterClose(panelId, replacementTabId, targetLeafId);
      if (getPanelVisibleLeafTabCount(panelId, targetLeafId, { excludingTabId: tabId }) === 0) {
        await removeEmptyVisiblePanelLeaf(panelId, targetLeafId, { excludingTabId: tabId });
      }
      if (getPanelVisibleTabCount(panelId, { excludingTabId: tabId }) === 0) {
        await updateActivePanel(panelId, { collapsed: true });
      }
      return true;
    },
    [
      activeSession,
      activatePanelTabAfterClose,
      getPanelVisibleLeafTabCount,
      getPanelVisibleTabCount,
      removeEmptyVisiblePanelLeaf,
      updateActivePanel,
      workbenchCodexControl,
    ],
  );

  const closePanelTab = useCallback(
    async (panelId: PanelId, tabId: string, leafId?: string) => {
      if (!activeSession) return;
      const targetLeafId = leafId ?? resolveLeafIdForPanelTab(activeSession, panelId, tabId);
      const replacementTabId = resolvePanelTabCloseTarget(panelId, tabId, targetLeafId);
      const previewTab = getRenderablePanelPreviewTab(
        activeSession,
        panelId,
        targetLeafId,
        previewTabsByPanel,
      );
      if (previewTab?.id === tabId) {
        await closePreviewTab(panelId, targetLeafId, replacementTabId);
        return;
      }
      if (await closeEphemeralPanelTab(panelId, tabId, replacementTabId)) return;

      const preserveEmptyLeafIds = getPreserveEmptyLeafIdsAfterDurableRemoval(
        panelId,
        targetLeafId,
        tabId,
      );
      const durableReplacementTabId =
        replacementTabId &&
        activeSession.tabs.some((tab) => tab.id === replacementTabId && tab.panelId === panelId)
          ? replacementTabId
          : null;
      await closeTab(tabId, {
        preserveEmptyLeafIds,
        preferredActiveLeafId: durableReplacementTabId ? targetLeafId : undefined,
        preferredActiveTabId: durableReplacementTabId ?? undefined,
      });
      if (!durableReplacementTabId) {
        await activatePanelTabAfterClose(panelId, replacementTabId, targetLeafId);
      }
      if (preserveEmptyLeafIds.length > 0) {
        await updateActivePanel(panelId, { collapsed: false });
      }
    },
    [
      activeSession,
      activatePanelTabAfterClose,
      closeEphemeralPanelTab,
      closePreviewTab,
      closeTab,
      getPreserveEmptyLeafIdsAfterDurableRemoval,
      previewTabsByPanel,
      resolvePanelTabCloseTarget,
      updateActivePanel,
    ],
  );

  const selectPanelTab = useCallback(
    async (panelId: PanelId, tabId: string, leafId?: string) => {
      if (!activeSession) return;
      const targetLeafId = leafId ?? resolveLeafIdForPanelTab(activeSession, panelId, tabId);
      const previewTab = getRenderablePanelPreviewTab(
        activeSession,
        panelId,
        targetLeafId,
        previewTabsByPanel,
      );
      if (previewTab?.id === tabId) return;

      const durableTabIds = new Set(
        activeSession.tabs.filter((tab) => tab.panelId === panelId).map((tab) => tab.id),
      );
      const selected = panelControllerRef.current.selectRenderableTab({
        sessionId: activeSession.id,
        panelId,
        leafId: targetLeafId,
        tabId,
        durableTabIds,
      });
      if (!selected || !durableTabIds.has(tabId)) return;
      await setActivePanelTab(panelId, tabId, { leafId: targetLeafId });
    },
    [activeSession, previewTabsByPanel, setActivePanelTab],
  );

  const closePlanSidePanel = useCallback<NonNullable<ThreadStageActions["onClosePlanSidePanel"]>>(
    async (input) => {
      if (!activeSession) return;
      const planTab = (planTabsBySession[activeSession.id] ?? []).find(
        (tab) => tab.id === "plan" && tab.planKey === input.planKey,
      );
      if (!planTab) return;
      const panelId: PanelId = "right";

      await closeEphemeralPanelTab(panelId, planTab.id);
    },
    [activeSession, closeEphemeralPanelTab, planTabsBySession],
  );

  const pinPreviewTab = useCallback(
    async (panelId: PanelId, tabId: string, leafId?: string) => {
      if (!activeSession) return;
      const targetLeafId = leafId ?? resolveSessionPanelActiveLeafId(activeSession, panelId);
      const imagePreview = (imageEditorTabsBySession[activeSession.id] ?? []).find(
        (tab) =>
          tab.id === tabId &&
          tab.preview === true &&
          tab.panelId === panelId &&
          (tab.leafId ?? targetLeafId) === targetLeafId,
      );
      if (imagePreview) {
        if (pinningPreviewTabIdsRef.current.has(tabId)) return;
        pinningPreviewTabIdsRef.current.add(tabId);
        try {
          const config = await materializeWorkbenchImageEditorSurfaceConfig(imagePreview.options);
          if (!config) {
            trackImageEditorPinOutcome({
              entrypoint: imagePreview.options.entrypoint,
              imageSource: imagePreview.options.imageSource,
              outcome: "failed",
              reason: "asset-materialization",
            });
            toast.danger("Could not keep this image tab open");
            return;
          }
          const created = createSessionViewTab({
            sessionId: activeSession.id,
            panelId,
            targetLeafId,
            clientTabId: imagePreview.id,
            title: imagePreview.title,
            kind: "image_editor",
            config,
          });
          if (!created) {
            trackImageEditorPinOutcome({
              entrypoint: imagePreview.options.entrypoint,
              imageSource: imagePreview.options.imageSource,
              outcome: "failed",
              reason: "scene-create",
            });
            toast.danger("Could not keep this image tab open");
            return;
          }
          panelControllerRef.current.removeEphemeralTab({
            sessionId: activeSession.id,
            panelId,
            leafId: targetLeafId,
            tabId,
          });
          trackImageEditorPinOutcome({
            entrypoint: imagePreview.options.entrypoint,
            imageSource: imagePreview.options.imageSource,
            outcome: "pinned",
          });
        } finally {
          pinningPreviewTabIdsRef.current.delete(tabId);
        }
        return;
      }
      const previewTab =
        previewTabsByPanel[
          makeWorkbenchSessionPanelSlotKey(activeSession.id, panelId, targetLeafId)
        ] ?? previewTabsByPanel[makeWorkbenchSessionPanelSlotKey(activeSession.id, panelId)];
      if (!previewTab || previewTab.id !== tabId) return;
      if (pinningPreviewTabIdsRef.current.has(tabId)) return;

      pinningPreviewTabIdsRef.current.add(tabId);
      try {
        panelControllerRef.current.durable.activateTab(activeSession, panelId, targetLeafId);
        const createInput = makePinnedPreviewTabCreateInput(
          activeSession,
          panelId,
          targetLeafId,
          previewTab,
        );
        createSessionViewTab(createInput);
        if (previewTab.kind === "page_stage") {
          clearPanelPreviewTab(activeSession.id, panelId, targetLeafId);
          return;
        }
        clearPanelPreviewTab(activeSession.id, panelId, targetLeafId);
      } finally {
        pinningPreviewTabIdsRef.current.delete(tabId);
      }
    },
    [
      activeSession,
      clearPanelPreviewTab,
      createSessionViewTab,
      imageEditorTabsBySession,
      pinningPreviewTabIdsRef,
      previewTabsByPanel,
    ],
  );

  const moveTabToPanel = useCallback(
    async (
      tabId: string,
      targetPanelId: string,
      targetLeafId?: string,
      targetIndex?: number,
      splitTarget?: { leafId: string; side: WorkbenchPanelSplitSide },
    ) => {
      if (!activeSession) return;
      if (targetPanelId !== "right" && targetPanelId !== "bottom") return;
      const saved = await workspaceTextDocumentRegistry.flush(tabId);
      if (!saved) {
        toast.danger("Resolve the file conflict before moving this tab");
        return;
      }
      const sideChatTab = (sideChatTabsBySession[activeSession.id] ?? []).find(
        (tab) => tab.id === tabId,
      );
      if (sideChatTab) {
        const nextLeafId =
          targetLeafId ?? resolveSessionPanelActiveLeafId(activeSession, targetPanelId);
        panelControllerRef.current.updateSideChatTabsBySession((current) => {
          const tabs = current[activeSession.id] ?? [];
          return {
            ...current,
            [activeSession.id]: tabs.map((tab) =>
              tab.id === tabId
                ? { ...tab, panelId: targetPanelId, leafId: nextLeafId, stateKey: tab.stateKey + 1 }
                : tab,
            ),
          };
        });
        panelControllerRef.current.updateSideChatActiveTabByPanel((current) => {
          const next = { ...current };
          if (sideChatTab.leafId)
            delete next[
              makeWorkbenchSessionPanelSlotKey(
                activeSession.id,
                sideChatTab.panelId,
                sideChatTab.leafId,
              )
            ];
          delete next[makeWorkbenchSessionPanelSlotKey(activeSession.id, sideChatTab.panelId)];
          next[makeWorkbenchSessionPanelSlotKey(activeSession.id, targetPanelId, nextLeafId)] =
            tabId;
          return next;
        });
        await updateActivePanel(targetPanelId, { collapsed: false });
        return;
      }
      const mcpAppTab = (mcpAppTabsBySession[activeSession.id] ?? []).find(
        (tab) => tab.id === tabId,
      );
      if (mcpAppTab) {
        const nextLeafId =
          targetLeafId ?? resolveSessionPanelActiveLeafId(activeSession, targetPanelId);
        panelControllerRef.current.updateMcpAppTabsBySession((current) => {
          const tabs = current[activeSession.id] ?? [];
          return {
            ...current,
            [activeSession.id]: tabs.map((tab) =>
              tab.id === tabId
                ? { ...tab, panelId: targetPanelId, leafId: nextLeafId, stateKey: tab.stateKey + 1 }
                : tab,
            ),
          };
        });
        panelControllerRef.current.updateMcpAppActiveTabByPanel((current) => {
          const next = { ...current };
          if (mcpAppTab.leafId)
            delete next[
              makeWorkbenchSessionPanelSlotKey(
                activeSession.id,
                mcpAppTab.panelId,
                mcpAppTab.leafId,
              )
            ];
          delete next[makeWorkbenchSessionPanelSlotKey(activeSession.id, mcpAppTab.panelId)];
          next[makeWorkbenchSessionPanelSlotKey(activeSession.id, targetPanelId, nextLeafId)] =
            tabId;
          return next;
        });
        await updateActivePanel(targetPanelId, { collapsed: false });
        return;
      }
      const durableTab = activeSession.tabs.find((tab) => tab.id === tabId) ?? null;
      const sourceLeafId = durableTab
        ? resolveLeafIdForPanelTab(activeSession, durableTab.panelId, tabId)
        : null;
      const preserveEmptyLeafIds =
        durableTab && sourceLeafId
          ? getPreserveEmptyLeafIdsAfterDurableRemoval(durableTab.panelId, sourceLeafId, tabId)
          : [];
      panelControllerRef.current.durable.moveTab(activeSession, {
        tabId,
        targetPanelId,
        targetLeafId,
        targetIndex,
        preserveEmptyLeafIds,
        splitTarget,
      });
      if (preserveEmptyLeafIds.length > 0) {
        await updateActivePanel(durableTab?.panelId ?? targetPanelId, { collapsed: false });
      }
    },
    [
      activeSession,
      getPreserveEmptyLeafIdsAfterDurableRemoval,
      mcpAppTabsBySession,
      sideChatTabsBySession,
      updateActivePanel,
    ],
  );

  const splitPanelGroup = useCallback(
    async (panelId: PanelId, leafId: string, side: WorkbenchPanelSplitSide, tabId?: string) => {
      if (!activeSession) return;
      if (!tabId) return;
      const leaf = findWorkbenchPanelLeaf(activeSession.panels[panelId].layout, leafId);
      if (!leaf || leaf.tabIds.length <= 1 || !leaf.tabIds.includes(tabId)) return;
      panelControllerRef.current.durable.splitLeaf(activeSession, {
        panelId,
        leafId,
        side,
        tabId,
      });
    },
    [activeSession],
  );

  const activatePanelGroup = useCallback(
    async (panelId: PanelId, leafId: string, tabId?: string | null) => {
      if (!activeSession) return;
      panelControllerRef.current.durable.activateTab(activeSession, panelId, leafId, tabId);
    },
    [activeSession],
  );

  const resizePanelGroup = useCallback(
    async (panelId: PanelId, branchId: string, ratio: number) => {
      if (!activeSession) return;
      panelControllerRef.current.durable.resizeBranch(activeSession, { panelId, branchId, ratio });
    },
    [activeSession],
  );

  const ensureActivePanelOpenWithoutRefresh = useCallback(
    async (panelId: PanelId) => {
      if (!activeSession || !activeSession.panels[panelId].collapsed) return;
      panelControllerRef.current.durable.patchPanel(activeSession, panelId, { collapsed: false });
    },
    [activeSession],
  );

  return {
    updateActivePanel,
    setActivePanelCollapsed,
    clearPanelPreviewTab,
    setActivePanelTab,
    reorderTabs,
    closeTab,
    closeEphemeralPanelTab,
    closePanelTab,
    selectPanelTab,
    closePlanSidePanel,
    pinPreviewTab,
    moveTabToPanel,
    splitPanelGroup,
    activatePanelGroup,
    resizePanelGroup,
    ensureActivePanelOpenWithoutRefresh,
  };
}
