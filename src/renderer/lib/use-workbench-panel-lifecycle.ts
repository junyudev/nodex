import { useCallback, useEffect, useEffectEvent, useRef, type MutableRefObject } from "react";
import { toast } from "@/components/ui/toast";
import {
  materializeWorkbenchImageEditorSurfaceConfig,
  trackImageEditorPinOutcome,
} from "@/features/user-attachment-image-editor";
import { terminalSessionStore } from "./terminal-session-store";
import { makeWorkbenchSessionPanelSlotKey } from "./workbench-panel-slot-key";
import { resolveSameLeafInsertionIndex } from "@/components/workbench/panel-tab-dnd";
import { makePinnedPreviewTabCreateInput } from "./workbench-panel-preview";
import { resolveSessionPanelActiveLeafId } from "./workbench-panel-placement";
import { readWorkbenchAgentContext } from "./workbench-agent-context";
import type { WorkbenchPanelController } from "./use-workbench-panel-controller";
import type { ExecuteWorkbenchUiCommand } from "./use-workbench-scene-commands";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";
import type { WorkbenchSessionRenderProjection } from "./workbench-session-presentation";
import type { ThreadStageActions } from "@/features/local-conversation";
import type {
  PanelId,
  WorkbenchPanelSplitSide,
  WorkbenchTabCreateInput,
  WorkbenchTabProjection,
} from "./types";

type ProjectSession = WorkbenchSessionRenderProjection;
interface WorkbenchPanelLifecycleInput {
  readonly activeSession: ProjectSession | null;
  readonly controller: WorkbenchPanelController;
  readonly createSessionViewTab: (
    input: WorkbenchTabCreateInput,
  ) => Promise<WorkbenchTabProjection | null>;
  readonly pinningPreviewTabIdsRef: MutableRefObject<Set<string>>;
  readonly executeSceneCommand: ExecuteWorkbenchUiCommand;
  readonly windowOwner: WorkbenchWindowOwner;
}

/** UI intent adapter for the same owner-addressed executor used by Agent commands. */
export function useWorkbenchPanelLifecycle({
  activeSession,
  controller,
  createSessionViewTab,
  pinningPreviewTabIdsRef,
  executeSceneCommand,
  windowOwner,
}: WorkbenchPanelLifecycleInput) {
  const panelControllerRef = useRef(controller);
  panelControllerRef.current = controller;
  const { previewTabsByPanel, imageEditorTabsBySession, planTabsBySession } = controller;
  const readPresentation = useCallback(
    () =>
      activeSession
        ? readWorkbenchAgentContext(windowOwner.read(), {
            kind: "session",
            sessionId: activeSession.id,
          })
        : null,
    [activeSession, windowOwner],
  );
  const execute = useCallback(
    async (
      command: Parameters<ExecuteWorkbenchUiCommand>[1],
      options?: Parameters<ExecuteWorkbenchUiCommand>[2],
    ) => {
      if (!activeSession) return null;
      return executeSceneCommand(
        { kind: "session", sessionId: activeSession.id },
        command,
        options,
      );
    },
    [activeSession, executeSceneCommand],
  );

  const updateActivePanel = useCallback(
    async (panelId: PanelId, input: Partial<ProjectSession["panels"][PanelId]>) => {
      const receipt = await execute({
        kind: "set_panel_state",
        panelId,
        ...(input.collapsed === undefined ? {} : { collapsed: input.collapsed }),
        ...(input.size === undefined ? {} : { size: input.size }),
      });
      return receipt && !receipt.error ? activeSession : null;
    },
    [activeSession, execute],
  );
  const setActivePanelCollapsed = useCallback(
    (panelId: PanelId, collapsed: boolean) => updateActivePanel(panelId, { collapsed }),
    [updateActivePanel],
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
    async (
      _panelId: PanelId,
      tabId: string,
      _options?: { openPanel?: boolean; leafId?: string },
    ) => {
      await execute({ kind: "activate_tab", tabId });
    },
    [execute],
  );
  const selectPanelTab = useCallback(
    async (panelId: PanelId, tabId: string, leafId?: string) =>
      setActivePanelTab(panelId, tabId, { leafId }),
    [setActivePanelTab],
  );
  const reorderTabs = useCallback(
    async (panelId: PanelId, tabId: string, targetIndex: number, leafId?: string) => {
      const presentation = readPresentation();
      const group = presentation?.groups.find(
        (candidate) =>
          candidate.panelId === panelId &&
          (leafId ? candidate.groupId === leafId : candidate.tabIds.includes(tabId)),
      );
      if (!group) return;
      const nextIndex = resolveSameLeafInsertionIndex({
        tabIds: group.tabIds,
        sourceTabId: tabId,
        targetIndex,
      });
      if (nextIndex === null || group.tabIds.indexOf(tabId) === nextIndex) return;
      const tabIds = group.tabIds.filter((id) => id !== tabId);
      tabIds.splice(nextIndex, 0, tabId);
      await execute({ kind: "reorder_tabs", panelId, groupId: group.groupId, tabIds });
    },
    [execute, readPresentation],
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
      await execute(
        { kind: "close_tab", tabId },
        { remove: { ...options, preferredActiveSurfaceId: options.preferredActiveTabId } },
      );
    },
    [execute],
  );
  const closePanelTab = useCallback(
    async (_panelId: PanelId, tabId: string, _leafId?: string) => closeTab(tabId),
    [closeTab],
  );
  const closeEphemeralPanelTab = useCallback(
    async (
      _panelId: PanelId,
      tabId: string,
      replacementTabId: string | null = null,
    ): Promise<boolean> => {
      const tab = readPresentation()?.tabs.find((candidate) => candidate.tabId === tabId);
      if (!tab?.auxiliary) return false;
      const receipt = await execute(
        { kind: "close_tab", tabId },
        replacementTabId ? { remove: { preferredActiveSurfaceId: replacementTabId } } : undefined,
      );
      return Boolean(receipt && !receipt.error);
    },
    [execute, readPresentation],
  );
  const closeExitedTerminalTab = useEffectEvent(async (terminalSessionId: string) => {
    const tab = readPresentation()?.tabs.find(
      (candidate) =>
        candidate.surface?.kind === "terminal" &&
        candidate.surface.config.terminalSessionId === terminalSessionId,
    );
    if (tab) await closeTab(tab.tabId);
  });
  useEffect(() => {
    terminalSessionStore.ensureEventSubscriptions();
    return terminalSessionStore.subscribeExit((event) => {
      void closeExitedTerminalTab(event.sessionId);
    });
  }, []);
  const closePlanSidePanel = useCallback<NonNullable<ThreadStageActions["onClosePlanSidePanel"]>>(
    async (input) => {
      if (!activeSession) return;
      const plan = planTabsBySession[activeSession.id]?.find(
        (tab) => tab.id === "plan" && tab.planKey === input.planKey,
      );
      if (plan) await closeEphemeralPanelTab("right", plan.id);
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
          const created = await createSessionViewTab({
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
        await createSessionViewTab(createInput);
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
      targetPanelId: PanelId,
      targetLeafId?: string,
      targetIndex?: number,
      splitTarget?: { leafId: string; side: WorkbenchPanelSplitSide },
    ) => {
      const presentation = readPresentation();
      const groupId =
        splitTarget?.leafId ??
        targetLeafId ??
        presentation?.panels.find((panel) => panel.panelId === targetPanelId)?.activeGroupId;
      if (!groupId || !presentation) return;
      const group = presentation.groups.find(
        (candidate) => candidate.panelId === targetPanelId && candidate.groupId === groupId,
      );
      if (!group) return;
      const index = splitTarget
        ? 0
        : Math.min(
            targetIndex ?? group.tabIds.length,
            group.tabIds.filter((id) => id !== tabId).length,
          );
      await execute({
        kind: "move_tab",
        tabId,
        panelId: targetPanelId,
        groupId,
        index,
        ...(splitTarget ? { splitSide: splitTarget.side } : {}),
      });
    },
    [execute, readPresentation],
  );
  const splitPanelGroup = useCallback(
    async (panelId: PanelId, leafId: string, side: WorkbenchPanelSplitSide, tabId?: string) => {
      await execute({
        kind: "split_group",
        panelId,
        groupId: leafId,
        side,
        ...(tabId ? { tabId } : {}),
      });
    },
    [execute],
  );
  const activatePanelGroup = useCallback(
    async (panelId: PanelId, leafId: string, tabId?: string | null) => {
      if (tabId) {
        await execute({ kind: "activate_tab", tabId });
        return;
      }
      if (!activeSession) return;
      panelControllerRef.current.durable.activateTab(activeSession, panelId, leafId);
    },
    [activeSession, execute],
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
      if (!activeSession?.panels[panelId].collapsed) return;
      await updateActivePanel(panelId, { collapsed: false });
    },
    [activeSession, updateActivePanel],
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
