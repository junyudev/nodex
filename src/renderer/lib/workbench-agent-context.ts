import type {
  WorkbenchAgentResult,
  WorkbenchObservedTab,
  WorkbenchRendererObservation,
  WorkbenchSubmitPresentation,
  WorkbenchSurfaceReference,
} from "../../shared/nodex-app-tools/workbench";
import {
  listWorkbenchPanelLeaves,
  type WorkbenchPanelNode,
} from "../../shared/workbench-panel-layout";
import {
  makeWorkbenchSceneKey,
  resolveWorkbenchSceneSurface,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import type { PanelId } from "../../shared/types";
import { buildSessionPanelRenderModel } from "./workbench-panel-projection";
import { makeWorkbenchPanelSlotKey } from "./workbench-panel-slot-key";
import {
  isTransientPanelTab,
  type ProjectSessionRenderableTab,
  type WorkbenchTabProjectionPanelTab,
} from "./workbench-panel-tab-model";
import { presentWorkbenchSessionPanelsWithScene } from "./workbench-scene-presentation";
import { projectWorkbenchScenePreviews } from "./workbench-scene-preview";
import type { WorkbenchWindowPresentationState } from "./workbench-window-owner";
import type { WorkbenchDatabaseViewReference } from "./workbench-database-view-presentation";

export interface WorkbenchAgentContextOptions {
  /** Exact Session metadata, when hydrated. Undefined stays unknown and grants no access. */
  readonly resolveSessionProjectId?: (sessionId: string) => string | null | undefined;
  readonly resolveDatabaseView?: (
    sceneOwner: WorkbenchSceneOwner,
    surface: WorkbenchDatabaseViewReference,
  ) => string | null;
}

type TabDescription = Pick<
  WorkbenchObservedTab,
  "tabId" | "protected" | "persisted" | "preview" | "surface" | "auxiliary"
>;
type PanelProjection = {
  readonly panels: WorkbenchSceneSnapshot["panels"];
  readonly collapsed: Readonly<Record<PanelId, boolean>>;
  readonly tabsByLeaf: Readonly<
    Record<PanelId, Readonly<Record<string, readonly TabDescription[]>>>
  >;
  readonly selectedTabsByLeaf: Readonly<Record<PanelId, Readonly<Record<string, string | null>>>>;
};

function selectedSceneOwner(state: WorkbenchWindowPresentationState): WorkbenchSceneOwner | null {
  const { location } = state.windowState;
  if (location.kind === "project") return { kind: "project", projectId: location.projectId };
  if (location.kind === "session") return { kind: "session", sessionId: location.sessionId };
  if (location.kind === "pages") return { kind: "pages" };
  return null;
}

export function discoverWorkbenchAgentScenes(
  state: WorkbenchWindowPresentationState,
  sessionId: string,
): Extract<WorkbenchAgentResult, { kind: "discover" }> {
  const sceneOwners = Object.values(
    state.windowState.scenesByOwnerKey,
  ).flatMap<WorkbenchSceneOwner>((scene) => {
    if (scene.owner.kind === "session" && scene.owner.sessionId === sessionId) return [scene.owner];
    if (
      scene.owner.kind === "project" &&
      scene.agentDock?.binding.kind === "session" &&
      scene.agentDock.binding.sessionId === sessionId
    )
      return [scene.owner];
    return [];
  });
  return {
    kind: "discover",
    presentationRevision: state.presentationRevision,
    selectedSceneOwner: selectedSceneOwner(state),
    sceneOwners,
  };
}

function surfaceReference(surface: WorkbenchSurfaceDescriptor): WorkbenchSurfaceReference {
  const { state: _state, stateKey: _stateKey, ...reference } = surface;
  return reference;
}

/** The Session preview adapter preserves existing identities; observation never creates a tab. */
function previewSurfaceReference(tab: WorkbenchTabProjectionPanelTab): WorkbenchSurfaceReference {
  const common = { id: tab.id, titleSnapshot: tab.title };
  if (tab.kind === "browser") {
    const { projectId: _projectId, ...config } = tab.config;
    return { ...common, kind: "browser", config: { ...config, browserTabId: tab.browserTabId } };
  }
  if (tab.kind === "db_view")
    return {
      ...common,
      kind: "db_view",
      config: tab.config,
    };
  if (tab.kind === "page_stage") {
    return {
      ...common,
      kind: "page_stage",
      config: tab.config,
    };
  }
  if (tab.kind === "canvas_stage") {
    return {
      ...common,
      kind: "canvas_stage",
      config: tab.config,
    };
  }
  if (tab.kind === "terminal") return { ...common, kind: "terminal", config: tab.config };
  if (tab.kind === "files") return { ...common, kind: "files", config: tab.config };
  if (tab.kind === "review") return { ...common, kind: "review", config: tab.config };
  return { ...common, kind: "image_editor", config: tab.config };
}

function auxiliaryReference(tab: ProjectSessionRenderableTab): WorkbenchObservedTab["auxiliary"] {
  if (!isTransientPanelTab(tab)) return null;
  if ("sideChat" in tab) return { kind: "side_chat", title: tab.title };
  if ("mcpApp" in tab) return { kind: "mcp_app", title: tab.title };
  if ("planPanel" in tab) return { kind: "plan", title: tab.title };
  if ("automationPanel" in tab) return { kind: "automation", title: tab.title };
  if ("processOutputPanel" in tab) return { kind: "process_output", title: tab.title };
  if ("imageEditor" in tab) return { kind: "image_editor", title: tab.title };
  return { kind: "agent", title: tab.title };
}

function sessionTabDescription(
  scene: WorkbenchSceneSnapshot,
  tab: ProjectSessionRenderableTab,
): TabDescription | null {
  const surface = scene.panelSurfacesById[tab.id];
  if (surface)
    return {
      tabId: tab.id,
      protected: false,
      persisted: true,
      preview: false,
      surface: surfaceReference(surface),
      auxiliary: null,
    };
  const auxiliary = auxiliaryReference(tab);
  if (auxiliary)
    return {
      tabId: tab.id,
      protected: false,
      persisted: false,
      preview: "preview" in tab && tab.preview === true,
      surface: null,
      auxiliary,
    };
  if (isTransientPanelTab(tab) || tab.preview !== true) return null;
  return {
    tabId: tab.id,
    protected: false,
    persisted: false,
    preview: true,
    surface: previewSurfaceReference(tab),
    auxiliary: null,
  };
}

function sessionPanelProjection(
  state: WorkbenchWindowPresentationState,
  scene: WorkbenchSceneSnapshot,
  options: WorkbenchAgentContextOptions,
): PanelProjection {
  if (scene.owner.kind !== "session")
    throw new Error("Session panel projection requires a Session Scene");
  const session = presentWorkbenchSessionPanelsWithScene(
    {
      id: scene.owner.sessionId,
      projectId: options.resolveSessionProjectId?.(scene.owner.sessionId),
    },
    scene,
  );
  const model = buildSessionPanelRenderModel({ ...state.ephemeralPanels, session });
  const describePanel = (panelId: PanelId) =>
    Object.fromEntries(
      Object.entries(model.renderableTabsByPanelLeaf[panelId]).map(([leafId, tabs]) => [
        leafId,
        tabs.flatMap((tab) => {
          const description = sessionTabDescription(scene, tab);
          return description ? [description] : [];
        }),
      ]),
    );
  return {
    panels: scene.panels,
    collapsed: { right: model.rightPanelCollapsed, bottom: model.bottomPanelCollapsed },
    tabsByLeaf: { right: describePanel("right"), bottom: describePanel("bottom") },
    selectedTabsByLeaf: model.activeTabIdsByPanelLeaf,
  };
}

function ownedPanelProjection(
  state: WorkbenchWindowPresentationState,
  scene: WorkbenchSceneSnapshot,
): PanelProjection {
  const projected = projectWorkbenchScenePreviews(
    scene,
    state.ephemeralPanels.previewSurfacesByPanel,
    state.ephemeralPanels.tabOrderByPanelGroup,
  );
  const ownerKey = makeWorkbenchSceneKey(scene.owner);
  const describePanel = (panelId: PanelId) =>
    Object.fromEntries(
      listWorkbenchPanelLeaves(projected.scene.panels[panelId].layout).map((leaf) => [
        leaf.id,
        leaf.tabIds.flatMap((tabId) => {
          const surface = resolveWorkbenchSceneSurface(projected.scene, tabId);
          if (!surface) return [];
          const preview = projected.previewSurfaceIds.has(tabId);
          return [
            {
              tabId,
              protected: tabId === scene.primary?.id,
              persisted: !preview,
              preview,
              surface: surfaceReference(surface),
              auxiliary: null,
            },
          ];
        }),
      ]),
    );
  const selectedTabs = (panelId: PanelId) =>
    Object.fromEntries(
      listWorkbenchPanelLeaves(projected.scene.panels[panelId].layout).map((leaf) => [
        leaf.id,
        leaf.activeTabId,
      ]),
    );
  return {
    panels: projected.scene.panels,
    collapsed: {
      right:
        state.ephemeralPanels.panelCollapsedOverrides[
          makeWorkbenchPanelSlotKey(ownerKey, "right")
        ] ?? scene.panels.right.collapsed,
      bottom:
        state.ephemeralPanels.panelCollapsedOverrides[
          makeWorkbenchPanelSlotKey(ownerKey, "bottom")
        ] ?? scene.panels.bottom.collapsed,
    },
    tabsByLeaf: { right: describePanel("right"), bottom: describePanel("bottom") },
    selectedTabsByLeaf: { right: selectedTabs("right"), bottom: selectedTabs("bottom") },
  };
}

function describeSplits(
  node: WorkbenchPanelNode,
  panelId: PanelId,
): { readonly groupIds: string[]; readonly splits: WorkbenchRendererObservation["splits"] } {
  if (node.type === "leaf") return { groupIds: [node.id], splits: [] };
  const first = describeSplits(node.first, panelId);
  const second = describeSplits(node.second, panelId);
  return {
    groupIds: [...first.groupIds, ...second.groupIds],
    splits: [
      {
        branchId: node.id,
        panelId,
        direction: node.direction,
        ratio: node.ratio,
        firstGroupIds: first.groupIds,
        secondGroupIds: second.groupIds,
      },
      ...first.splits,
      ...second.splits,
    ],
  };
}

/** Read the live presentation owner without materializing an absent Scene or changing selection. */
export function readWorkbenchAgentContext(
  state: WorkbenchWindowPresentationState,
  sceneOwner: WorkbenchSceneOwner,
  options: WorkbenchAgentContextOptions = {},
): WorkbenchRendererObservation | null {
  const ownerKey = makeWorkbenchSceneKey(sceneOwner);
  const scene = state.windowState.scenesByOwnerKey[ownerKey];
  if (!scene || makeWorkbenchSceneKey(scene.owner) !== ownerKey) return null;
  const selectedOwner = selectedSceneOwner(state);
  const mounted = selectedOwner !== null && makeWorkbenchSceneKey(selectedOwner) === ownerKey;
  const projection =
    scene.owner.kind === "session"
      ? sessionPanelProjection(state, scene, options)
      : ownedPanelProjection(state, scene);
  const groups: WorkbenchRendererObservation["groups"] = [];
  const tabs: WorkbenchObservedTab[] = [];
  const panels: WorkbenchRendererObservation["panels"] = [];
  const splits: WorkbenchRendererObservation["splits"] = [];
  for (const panelId of ["right", "bottom"] as const) {
    const panel = projection.panels[panelId];
    const collapsed = projection.collapsed[panelId];
    panels.push({
      panelId,
      collapsed,
      activeGroupId: panel.layout.activeLeafId,
      maximizedGroupId: panel.layout.maximizedLeafId ?? null,
      size: { ...panel.size },
    });
    splits.push(...describeSplits(panel.layout.root, panelId).splits);
    for (const leaf of listWorkbenchPanelLeaves(panel.layout)) {
      const groupTabs = projection.tabsByLeaf[panelId][leaf.id] ?? [];
      const selectedTabId = projection.selectedTabsByLeaf[panelId][leaf.id] ?? null;
      const visible =
        mounted &&
        !collapsed &&
        (!panel.layout.maximizedLeafId || panel.layout.maximizedLeafId === leaf.id);
      const focus = state.focusedPanelGroup;
      groups.push({
        groupId: leaf.id,
        panelId,
        tabIds: groupTabs.map((tab) => tab.tabId),
        selectedTabId,
        focused:
          visible &&
          focus?.ownerKey === ownerKey &&
          focus.panelId === panelId &&
          focus.leafId === leaf.id,
        visible,
      });
      tabs.push(
        ...groupTabs.map((tab) => ({
          ...tab,
          panelId,
          groupId: leaf.id,
          selected: tab.tabId === selectedTabId,
          visible: visible && tab.tabId === selectedTabId,
        })),
      );
    }
  }
  if (scene.owner.kind === "session" && scene.primary) {
    const rightFullWidth =
      !projection.collapsed.right && projection.panels.right.size.fullWidth === true;
    tabs.unshift({
      tabId: scene.primary.id,
      panelId: null,
      groupId: null,
      protected: true,
      persisted: true,
      preview: false,
      selected: true,
      visible: mounted && !rightFullWidth,
      surface: surfaceReference(scene.primary),
      auxiliary: null,
    });
  }
  const focusedGroup = groups.find((group) => group.focused && group.selectedTabId !== null);
  const focusedTarget = focusedGroup?.selectedTabId
    ? {
        tabId: focusedGroup.selectedTabId,
        panelId: focusedGroup.panelId,
        groupId: focusedGroup.groupId,
      }
    : null;
  return {
    sceneOwner: scene.owner,
    selectedSceneOwner: selectedOwner,
    presentationRevision: state.presentationRevision,
    mounted,
    focusedTarget,
    tabs: tabs.map((tab) => {
      if (tab.surface?.kind !== "db_view") return tab;
      const databaseViewId = options.resolveDatabaseView?.(scene.owner, tab.surface);
      if (!databaseViewId) return tab;
      return {
        ...tab,
        surface: {
          ...tab.surface,
          config: {
            ...tab.surface.config,
            target: { kind: "database-view" as const, databaseViewId },
          },
        },
      };
    }),
    groups,
    panels,
    splits,
  };
}

/** Capture at the originating submit event, before any turn delegation or asynchronous work. */
export function readWorkbenchSubmitPresentation(
  state: WorkbenchWindowPresentationState,
  rendererGeneration: string,
  options: WorkbenchAgentContextOptions = {},
): WorkbenchSubmitPresentation {
  const sceneOwner = selectedSceneOwner(state);
  const observation = sceneOwner ? readWorkbenchAgentContext(state, sceneOwner, options) : null;
  return {
    rendererGeneration,
    sceneOwner,
    presentationRevision: state.presentationRevision,
    focusedTarget: observation?.focusedTarget ?? null,
    selectedTabs: observation?.tabs.filter((tab) => tab.selected) ?? [],
  };
}
