import type { ThreadPlanSidePanelState } from "@/features/local-conversation/thread-stage-types";
import type { PanelId, WorkbenchPanelState, WorkbenchTabProjection } from "@/lib/types";
import type { WorkbenchSessionPanelProjection } from "@/lib/workbench-session-presentation";
import {
  readPageStagePanelTabPageRef,
  resolveSessionPanelActiveLeafId,
} from "@/lib/workbench-panel-placement";
import type { ProjectSessionPreviewTab } from "@/lib/workbench-panel-preview";
import { orderWorkbenchPanelTabs } from "./workbench-panel-order";
import { makeWorkbenchSessionPanelSlotKey } from "@/lib/workbench-panel-slot-key";
import {
  isProjectSessionFilesPreviewTab,
  isTransientPanelTab,
  type AgentPanelTab,
  type AutomationPanelTab,
  type ImageEditorPanelTab,
  type McpAppPanelTab,
  type PlanPanelTab,
  type ProcessOutputPanelTab,
  type ProjectSessionRenderableTab,
  type SideChatPanelTab,
} from "@/lib/workbench-panel-tab-model";
import {
  findWorkbenchPanelLeaf,
  listWorkbenchPanelLeaves,
} from "../../shared/workbench-panel-layout";

export interface SessionPanelRenderModel {
  rightPanel: WorkbenchPanelState;
  bottomPanel: WorkbenchPanelState;
  rightActiveLeafId: string;
  bottomActiveLeafId: string;
  rightRenderableTabs: ProjectSessionRenderableTab[];
  bottomRenderableTabs: ProjectSessionRenderableTab[];
  rightActiveTabId: string | null;
  bottomActiveTabId: string | null;
  rightPanelCollapsed: boolean;
  bottomPanelCollapsed: boolean;
  sidePanelOpen: boolean;
  bottomPanelOpen: boolean;
  rightPanelFullWidth: boolean;
  rightActiveRenderableTab: ProjectSessionRenderableTab | null;
  threadPlanSidePanelState: ThreadPlanSidePanelState | null;
  renderableTabsByPanelLeaf: Record<PanelId, Record<string, ProjectSessionRenderableTab[]>>;
  activeTabIdsByPanelLeaf: Record<PanelId, Record<string, string | null>>;
  browserRetentionTabs: WorkbenchTabProjection[];
  visibleBrowserTabIds: ReadonlySet<string>;
}

export interface SessionPanelRenderModelInput {
  tabOrderByPanelGroup?: Readonly<Record<string, readonly string[]>>;
  session: WorkbenchSessionPanelProjection;
  previewTabsByPanel: Record<string, ProjectSessionPreviewTab>;
  sideChatTabsBySession: Record<string, SideChatPanelTab[]>;
  sideChatActiveTabByPanel: Record<string, string>;
  mcpAppTabsBySession: Record<string, McpAppPanelTab[]>;
  mcpAppActiveTabByPanel: Record<string, string>;
  planTabsBySession: Record<string, PlanPanelTab[]>;
  planActiveTabByPanel: Record<string, string>;
  automationTabsBySession: Record<string, AutomationPanelTab[]>;
  automationActiveTabByPanel: Record<string, string>;
  backgroundAgentTabsBySession: Record<string, AgentPanelTab[]>;
  backgroundAgentActiveTabByPanel: Record<string, string>;
  processOutputTabsBySession: Record<string, ProcessOutputPanelTab[]>;
  processOutputActiveTabByPanel: Record<string, string>;
  imageEditorTabsBySession: Record<string, ImageEditorPanelTab[]>;
  imageEditorActiveTabByPanel: Record<string, string>;
  panelCollapsedOverrides: Record<string, boolean>;
  activePlanKeyBySession: Record<string, string>;
}

export function shouldExpandImageEditorPanelForViewChange(input: {
  readonly panelIsFullWidth: boolean;
  readonly previousView: "playground" | "single";
  readonly view: "playground" | "single";
}): boolean {
  return (
    !input.panelIsFullWidth && input.previousView !== "playground" && input.view === "playground"
  );
}

function hasDurablePanelTabInLeaf(
  session: WorkbenchSessionPanelProjection,
  panelId: PanelId,
  leafId: string,
  tabId: string,
): boolean {
  const leaf = findWorkbenchPanelLeaf(session.panels[panelId].layout, leafId);
  if (!leaf?.tabIds.includes(tabId)) return false;
  return session.tabs.some((tab) => tab.id === tabId && tab.panelId === panelId);
}

export function getRenderablePanelPreviewTab(
  session: WorkbenchSessionPanelProjection,
  panelId: PanelId,
  leafId: string,
  previewTabsByPanel: Record<string, ProjectSessionPreviewTab>,
): ProjectSessionPreviewTab | null {
  const activeLeafId = resolveSessionPanelActiveLeafId(session, panelId);
  const previewTab =
    previewTabsByPanel[makeWorkbenchSessionPanelSlotKey(session.id, panelId, leafId)] ??
    (leafId === activeLeafId
      ? previewTabsByPanel[makeWorkbenchSessionPanelSlotKey(session.id, panelId)]
      : null) ??
    null;
  if (!previewTab) return null;
  if (hasDurablePanelTabInLeaf(session, panelId, leafId, previewTab.id)) {
    return null;
  }
  return previewTab;
}

function resolveActiveRenderableTabId(
  renderableTabs: readonly ProjectSessionRenderableTab[],
  fallbackActiveTabId: string | null,
  activeTabCandidates: readonly (string | null)[],
): string | null {
  for (const candidate of activeTabCandidates) {
    if (!candidate) continue;
    if (renderableTabs.some((tab) => tab.id === candidate)) {
      return candidate;
    }
  }
  if (fallbackActiveTabId && renderableTabs.some((tab) => tab.id === fallbackActiveTabId)) {
    return fallbackActiveTabId;
  }
  return renderableTabs[0]?.id ?? null;
}

function activeEphemeralTabId(
  activeByPanel: Record<string, string>,
  sessionId: string,
  panelId: PanelId,
  leafId: string,
  activeLeafId: string,
): string | null {
  return (
    activeByPanel[makeWorkbenchSessionPanelSlotKey(sessionId, panelId, leafId)] ??
    (leafId === activeLeafId
      ? activeByPanel[makeWorkbenchSessionPanelSlotKey(sessionId, panelId)]
      : null) ??
    null
  );
}

export function buildSessionPanelRenderModel(
  input: SessionPanelRenderModelInput,
): SessionPanelRenderModel {
  const {
    session,
    previewTabsByPanel,
    sideChatTabsBySession,
    sideChatActiveTabByPanel,
    mcpAppTabsBySession,
    mcpAppActiveTabByPanel,
    planTabsBySession,
    planActiveTabByPanel,
    automationTabsBySession,
    automationActiveTabByPanel,
    backgroundAgentTabsBySession,
    backgroundAgentActiveTabByPanel,
    processOutputTabsBySession,
    processOutputActiveTabByPanel,
    imageEditorTabsBySession,
    imageEditorActiveTabByPanel,
    panelCollapsedOverrides,
    activePlanKeyBySession,
  } = input;
  const rightPanel = session.panels.right;
  const bottomPanel = session.panels.bottom;
  const rightActiveLeafId = resolveSessionPanelActiveLeafId(session, "right");
  const bottomActiveLeafId = resolveSessionPanelActiveLeafId(session, "bottom");
  const renderableTabsByPanelLeaf: Record<
    PanelId,
    Record<string, ProjectSessionRenderableTab[]>
  > = {
    right: {},
    bottom: {},
  };
  const activeTabIdsByPanelLeaf: Record<PanelId, Record<string, string | null>> = {
    right: {},
    bottom: {},
  };
  const durableById = new Map(session.tabs.map((tab) => [tab.id, tab]));

  for (const panelId of ["right", "bottom"] as const) {
    const panel = session.panels[panelId];
    const activeLeafId = panelId === "right" ? rightActiveLeafId : bottomActiveLeafId;
    for (const leaf of listWorkbenchPanelLeaves(panel.layout)) {
      const durableTabs = leaf.tabIds.flatMap((tabId) => {
        const tab = durableById.get(tabId);
        return tab && tab.panelId === panelId ? [tab] : [];
      });
      const matchingLeaf = (tab: { panelId: PanelId; leafId?: string }) =>
        tab.panelId === panelId && (tab.leafId ?? activeLeafId) === leaf.id;
      const sideChatTabs = (sideChatTabsBySession[session.id] ?? []).filter(matchingLeaf);
      const mcpAppTabs = (mcpAppTabsBySession[session.id] ?? []).filter(matchingLeaf);
      const planTabs = (planTabsBySession[session.id] ?? []).filter(matchingLeaf);
      const automationTabs = (automationTabsBySession[session.id] ?? []).filter(matchingLeaf);
      const backgroundAgentTabs = (backgroundAgentTabsBySession[session.id] ?? []).filter(
        matchingLeaf,
      );
      const processOutputTabs = (processOutputTabsBySession[session.id] ?? []).filter(matchingLeaf);
      const imageEditorTabs = (imageEditorTabsBySession[session.id] ?? []).filter(matchingLeaf);
      const previewTab = getRenderablePanelPreviewTab(
        session,
        panelId,
        leaf.id,
        previewTabsByPanel,
      );
      const renderableTabs = orderWorkbenchPanelTabs<ProjectSessionRenderableTab>(
        [
          ...durableTabs,
          ...sideChatTabs,
          ...mcpAppTabs,
          ...planTabs,
          ...automationTabs,
          ...backgroundAgentTabs,
          ...processOutputTabs,
          ...imageEditorTabs,
          ...(previewTab ? [previewTab] : []),
        ],
        input.tabOrderByPanelGroup?.[
          makeWorkbenchSessionPanelSlotKey(session.id, panelId, leaf.id)
        ],
      );
      const sideChatActiveTabId = activeEphemeralTabId(
        sideChatActiveTabByPanel,
        session.id,
        panelId,
        leaf.id,
        activeLeafId,
      );
      const mcpAppActiveTabId = activeEphemeralTabId(
        mcpAppActiveTabByPanel,
        session.id,
        panelId,
        leaf.id,
        activeLeafId,
      );
      const planActiveTabId = activeEphemeralTabId(
        planActiveTabByPanel,
        session.id,
        panelId,
        leaf.id,
        activeLeafId,
      );
      const automationActiveTabId = activeEphemeralTabId(
        automationActiveTabByPanel,
        session.id,
        panelId,
        leaf.id,
        activeLeafId,
      );
      const backgroundAgentActiveTabId = activeEphemeralTabId(
        backgroundAgentActiveTabByPanel,
        session.id,
        panelId,
        leaf.id,
        activeLeafId,
      );
      const processOutputActiveTabId = activeEphemeralTabId(
        processOutputActiveTabByPanel,
        session.id,
        panelId,
        leaf.id,
        activeLeafId,
      );
      const imageEditorActiveTabId = activeEphemeralTabId(
        imageEditorActiveTabByPanel,
        session.id,
        panelId,
        leaf.id,
        activeLeafId,
      );

      renderableTabsByPanelLeaf[panelId][leaf.id] = renderableTabs;
      activeTabIdsByPanelLeaf[panelId][leaf.id] = resolveActiveRenderableTabId(
        renderableTabs,
        leaf.activeTabId,
        [
          previewTab?.id ?? null,
          planActiveTabId,
          automationActiveTabId,
          mcpAppActiveTabId,
          sideChatActiveTabId,
          backgroundAgentActiveTabId,
          processOutputActiveTabId,
          imageEditorActiveTabId,
        ],
      );
    }
  }

  const rightRenderableTabs = renderableTabsByPanelLeaf.right[rightActiveLeafId] ?? [];
  const bottomRenderableTabs = renderableTabsByPanelLeaf.bottom[bottomActiveLeafId] ?? [];
  const rightActiveTabId = activeTabIdsByPanelLeaf.right[rightActiveLeafId] ?? null;
  const bottomActiveTabId = activeTabIdsByPanelLeaf.bottom[bottomActiveLeafId] ?? null;
  const rightPanelCollapsed =
    panelCollapsedOverrides[makeWorkbenchSessionPanelSlotKey(session.id, "right")] ??
    rightPanel.collapsed;
  const bottomPanelCollapsed =
    panelCollapsedOverrides[makeWorkbenchSessionPanelSlotKey(session.id, "bottom")] ??
    bottomPanel.collapsed;
  const sidePanelOpen = !rightPanelCollapsed;
  const bottomPanelOpen = !bottomPanelCollapsed;
  const rightActiveRenderableTab = rightActiveTabId
    ? (rightRenderableTabs.find((tab) => tab.id === rightActiveTabId) ?? null)
    : null;
  const rightPanelFullWidth = sidePanelOpen && (rightPanel.size.fullWidth ?? false);
  const browserRetentionTabs = [
    ...session.tabs.filter((tab) => tab.kind === "browser"),
    ...Object.values(previewTabsByPanel).filter(
      (tab): tab is WorkbenchTabProjection & { preview: true } =>
        tab.sessionId === session.id &&
        tab.kind === "browser" &&
        typeof tab.browserTabId === "string",
    ),
  ];
  const browserTabIds = new Set(browserRetentionTabs.map((tab) => tab.id));
  const visibleBrowserTabIds = new Set<string>();
  const collectVisibleBrowserTabIds = (panelId: PanelId, panelOpen: boolean) => {
    if (!panelOpen) return;
    const layout = session.panels[panelId].layout;
    const leafIds = layout.maximizedLeafId
      ? [layout.maximizedLeafId]
      : listWorkbenchPanelLeaves(layout).map((leaf) => leaf.id);
    for (const leafId of leafIds) {
      const tabId = activeTabIdsByPanelLeaf[panelId][leafId];
      if (tabId && browserTabIds.has(tabId)) {
        visibleBrowserTabIds.add(tabId);
      }
    }
  };
  collectVisibleBrowserTabIds("right", sidePanelOpen);
  collectVisibleBrowserTabIds("bottom", bottomPanelOpen);

  return {
    rightPanel,
    bottomPanel,
    rightActiveLeafId,
    bottomActiveLeafId,
    rightRenderableTabs,
    bottomRenderableTabs,
    rightActiveTabId,
    bottomActiveTabId,
    rightPanelCollapsed,
    bottomPanelCollapsed,
    sidePanelOpen,
    bottomPanelOpen,
    rightPanelFullWidth,
    rightActiveRenderableTab,
    threadPlanSidePanelState: {
      rightPanelEnabled: typeof session.projectId === "string",
      activePlanKey: activePlanKeyBySession[session.id] ?? null,
      activeRightPanelTabId: sidePanelOpen ? rightActiveTabId : null,
    },
    renderableTabsByPanelLeaf,
    activeTabIdsByPanelLeaf,
    browserRetentionTabs,
    visibleBrowserTabIds,
  };
}

export function collectMountedBrowserTabIds(
  session: WorkbenchSessionPanelProjection,
  model: SessionPanelRenderModel,
  mountedPanels: Readonly<Record<PanelId, boolean>>,
): ReadonlySet<string> {
  const browserTabIds = new Set(model.browserRetentionTabs.map((tab) => tab.id));
  const mountedBrowserTabIds = new Set<string>();

  for (const panelId of ["right", "bottom"] as const) {
    if (!mountedPanels[panelId]) continue;
    const layout = session.panels[panelId].layout;
    const leafIds = layout.maximizedLeafId
      ? [layout.maximizedLeafId]
      : listWorkbenchPanelLeaves(layout).map((leaf) => leaf.id);
    for (const leafId of leafIds) {
      const tabId = model.activeTabIdsByPanelLeaf[panelId][leafId];
      if (tabId && browserTabIds.has(tabId)) {
        mountedBrowserTabIds.add(tabId);
      }
    }
  }

  return mountedBrowserTabIds;
}

export function collectPanelPresentedPageIds(
  session: WorkbenchSessionPanelProjection,
  model: SessionPanelRenderModel,
): ReadonlySet<string> {
  const pageIds = new Set<string>();
  const collectPanelVisiblePageStagePages = (panelId: PanelId, panelOpen: boolean) => {
    if (!panelOpen) return;

    const layout = session.panels[panelId].layout;
    const leafIds = layout.maximizedLeafId
      ? [layout.maximizedLeafId]
      : listWorkbenchPanelLeaves(layout).map((leaf) => leaf.id);

    for (const leafId of leafIds) {
      const activeTabId = model.activeTabIdsByPanelLeaf[panelId][leafId] ?? null;
      const activeTab = activeTabId
        ? (model.renderableTabsByPanelLeaf[panelId][leafId]?.find(
            (tab) => tab.id === activeTabId,
          ) ?? null)
        : null;
      if (!activeTab || isTransientPanelTab(activeTab)) continue;
      if (isProjectSessionFilesPreviewTab(activeTab)) continue;

      const pageRef = readPageStagePanelTabPageRef(activeTab);
      if (!pageRef) continue;
      pageIds.add(pageRef.pageId);
    }
  };

  collectPanelVisiblePageStagePages("right", model.sidePanelOpen);
  collectPanelVisiblePageStagePages("bottom", model.bottomPanelOpen);
  return pageIds;
}
