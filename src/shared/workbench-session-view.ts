import { workbenchFileResourceId } from "./workbench-resource-identity";
import {
  activateWorkbenchPanelLeaf,
  findWorkbenchPanelLeaf,
  findWorkbenchPanelLeafForTab,
  flattenWorkbenchPanelTabIds,
  insertWorkbenchPanelTabInBackground,
  insertWorkbenchPanelLeaf,
  listWorkbenchPanelLeaves,
  makeWorkbenchPanelLayout,
  mergeWorkbenchPanelLeaf,
  moveWorkbenchPanelTab,
  normalizeWorkbenchPanelLayout,
  pruneEmptyWorkbenchPanelLeaves,
  removeWorkbenchPanelTab,
  reorderWorkbenchPanelLeafTabs,
  setWorkbenchPanelBranchRatio,
  setWorkbenchPanelMaximizedLeaf,
  splitWorkbenchPanelLeaf,
  type WorkbenchPanelLayout,
  type WorkbenchPanelNode,
  type WorkbenchPanelSplitLeaf,
  type WorkbenchPanelSplitSide,
} from "./workbench-panel-layout";
import type { BrowserSidebarDeviceToolbarState } from "./browser-sidebar";
import { createSecureRuntimeId } from "./secure-runtime-id";
import type { WorkbenchReviewConfig } from "./workbench-review";
import type { WorkbenchImageEditorSurfaceConfig } from "./workbench-image-editor";

export const WORKBENCH_SESSION_VIEW_VERSION = 4 as const;
export const WORKBENCH_SESSION_VIEW_MAX_TABS = 2_048;

export type WorkbenchPanelId = "right" | "bottom";
export type {
  WorkbenchPanelLayout,
  WorkbenchPanelLayoutV2,
  WorkbenchPanelNode,
  WorkbenchPanelSplitBranch,
  WorkbenchPanelSplitLeaf,
  WorkbenchPanelSplitSide,
} from "./workbench-panel-layout";

export interface WorkbenchPanelSize {
  widthPx?: number;
  heightPx?: number;
  fullWidth?: boolean;
}

export interface WorkbenchPanelState {
  collapsed: boolean;
  layout: WorkbenchPanelLayout;
  size: WorkbenchPanelSize;
}

export type WorkbenchSessionViewTabKind =
  | "db_view"
  | "page_stage"
  | "canvas_stage"
  | "terminal"
  | "browser"
  | "review"
  | "files"
  | "image_editor";

export interface WorkbenchDbViewTabConfig {
  projectId: string;
  databaseViewId: string;
}

export interface WorkbenchPageStageTabConfig {
  projectId: string;
  pageId: string;
  titleSnapshot?: string;
}

export interface WorkbenchCanvasStageTabConfig {
  projectId: string;
  canvasBlockId: string;
  titleSnapshot?: string;
}

export interface WorkbenchTerminalTabConfig {
  terminalSessionId: string;
}

export interface WorkbenchBrowserTabConfig {
  browserTabId: string;
  browserStorageId?: string;
  url?: string;
  title?: string;
  faviconUrl?: string;
  deviceToolbarVisible?: boolean;
  deviceToolbarState?: BrowserSidebarDeviceToolbarState;
}

export type WorkbenchReviewTabConfig = WorkbenchReviewConfig;

export interface WorkbenchFilesTabConfig {
  projectId: string | null;
  hostId: "local";
  workspaceRoot: string | null;
  cwd: string | null;
  path?: string;
}

export interface WorkbenchSessionViewTabConfigByKind {
  db_view: WorkbenchDbViewTabConfig;
  page_stage: WorkbenchPageStageTabConfig;
  canvas_stage: WorkbenchCanvasStageTabConfig;
  terminal: WorkbenchTerminalTabConfig;
  browser: WorkbenchBrowserTabConfig;
  review: WorkbenchReviewTabConfig;
  files: WorkbenchFilesTabConfig;
  image_editor: WorkbenchImageEditorSurfaceConfig;
}

type WorkbenchSessionViewTabVariant = {
  [Kind in WorkbenchSessionViewTabKind]: {
    kind: Kind;
    config: WorkbenchSessionViewTabConfigByKind[Kind];
  };
}[WorkbenchSessionViewTabKind];

export type WorkbenchSessionViewTab = {
  id: string;
  titleSnapshot: string;
  stateKey: number;
  state: unknown;
} & WorkbenchSessionViewTabVariant;

export interface WorkbenchSessionViewSnapshot {
  version: typeof WORKBENCH_SESSION_VIEW_VERSION;
  sessionId: string;
  tabsById: Record<string, WorkbenchSessionViewTab>;
  panels: Record<WorkbenchPanelId, WorkbenchPanelState>;
  lastFocusedPanelId: WorkbenchPanelId | null;
  touchedAt: string;
}

export interface WorkbenchSessionViewIdentityFactory {
  createId(kind: "tab" | "leaf" | "branch" | "browser"): string;
}

export interface WorkbenchSessionViewTabCreateInput {
  panelId: WorkbenchPanelId;
  presentation?: WorkbenchSurfacePresentation;
  targetLeafId?: string;
  targetIndex?: number;
  tab: WorkbenchSessionViewTab;
}

export type WorkbenchSurfacePresentation = "activate" | "background";

export interface WorkbenchSessionViewTabRemoveOptions {
  preserveEmptyLeafIds?: string[];
  preferredActiveLeafId?: string | null;
  preferredActiveTabId?: string | null;
}

export interface WorkbenchSessionViewTabMoveInput {
  tabId: string;
  targetPanelId: WorkbenchPanelId;
  targetLeafId?: string;
  targetIndex?: number;
  preserveEmptyLeafIds?: string[];
  splitTarget?: {
    leafId: string;
    side: WorkbenchPanelSplitSide;
  };
  identityFactory?: WorkbenchSessionViewIdentityFactory;
}

export interface WorkbenchSessionViewLeafInput {
  panelId: WorkbenchPanelId;
  leafId: string;
}

export interface WorkbenchSessionViewLeafSplitInput extends WorkbenchSessionViewLeafInput {
  side: WorkbenchPanelSplitSide;
  tabId?: string;
  identityFactory?: WorkbenchSessionViewIdentityFactory;
}

export interface WorkbenchSessionViewPanelPatch {
  collapsed?: boolean;
  size?: Partial<WorkbenchPanelSize>;
}

export interface WorkbenchSessionMaterializationTarget {
  id: string;
  projectId: string | null;
  /**
   * Database View to present in the initial full-width db_view tab, already
   * resolved by the caller from the Project's current default View. This
   * legacy materializer is used only while decoding pre-Scene layouts. Null
   * materializes an empty view.
   */
  databaseViewId: string | null;
}

export interface CloneWorkbenchLayout {
  sessionViewsBySessionId: Record<string, WorkbenchSessionViewSnapshot>;
}

const PANEL_IDS = ["right", "bottom"] as const satisfies readonly WorkbenchPanelId[];
const DEFAULT_RIGHT_WIDTH_PX = 600;
const DEFAULT_BOTTOM_HEIGHT_PX = 280;
const MIN_PANEL_SIZE_PX = 80;
const MAX_PANEL_SIZE_PX = 10_000;

function currentIso(): string {
  return new Date().toISOString();
}

function defaultIdentityFactory(): WorkbenchSessionViewIdentityFactory {
  return {
    createId(kind) {
      return createSecureRuntimeId(kind);
    },
  };
}

function createPanel(
  panelId: WorkbenchPanelId,
  collapsed: boolean,
  leafId: string,
): WorkbenchPanelState {
  return {
    collapsed,
    layout: makeWorkbenchPanelLayout([], null, leafId),
    size:
      panelId === "right"
        ? { widthPx: DEFAULT_RIGHT_WIDTH_PX, fullWidth: false }
        : { heightPx: DEFAULT_BOTTOM_HEIGHT_PX },
  };
}

function clampPanelSize(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_PANEL_SIZE_PX, Math.max(MIN_PANEL_SIZE_PX, value));
}

function normalizePanelSize(
  panelId: WorkbenchPanelId,
  value: WorkbenchPanelSize,
): WorkbenchPanelSize {
  if (panelId === "right") {
    return {
      widthPx: clampPanelSize(value.widthPx) ?? DEFAULT_RIGHT_WIDTH_PX,
      fullWidth: value.fullWidth === true,
    };
  }
  return {
    heightPx: clampPanelSize(value.heightPx) ?? DEFAULT_BOTTOM_HEIGHT_PX,
  };
}

function mapPanelNode(
  node: WorkbenchPanelNode,
  visitLeaf: (leaf: WorkbenchPanelSplitLeaf) => WorkbenchPanelSplitLeaf,
): WorkbenchPanelNode {
  if (node.type === "leaf") return visitLeaf(node);
  return {
    ...node,
    first: mapPanelNode(node.first, visitLeaf),
    second: mapPanelNode(node.second, visitLeaf),
  };
}

function removeDuplicateAndUnknownTabIds(
  layout: WorkbenchPanelLayout,
  knownTabIds: ReadonlySet<string>,
  seenTabIds: Set<string>,
): WorkbenchPanelLayout {
  return {
    ...layout,
    root: mapPanelNode(layout.root, (leaf) => {
      const tabIds = leaf.tabIds.filter((tabId) => {
        if (!knownTabIds.has(tabId) || seenTabIds.has(tabId)) return false;
        seenTabIds.add(tabId);
        return true;
      });
      const validTabIds = new Set(tabIds);
      return {
        ...leaf,
        tabIds,
        activeTabId:
          leaf.activeTabId && validTabIds.has(leaf.activeTabId)
            ? leaf.activeTabId
            : (tabIds[0] ?? null),
        mruTabIds: leaf.mruTabIds.filter((tabId) => validTabIds.has(tabId)),
      };
    }),
  };
}

function touch(
  view: WorkbenchSessionViewSnapshot,
  touchedAt = currentIso(),
): WorkbenchSessionViewSnapshot {
  return { ...view, touchedAt };
}

function panelContainingTab(
  view: WorkbenchSessionViewSnapshot,
  tabId: string,
): WorkbenchPanelId | null {
  for (const panelId of PANEL_IDS) {
    if (findWorkbenchPanelLeafForTab(view.panels[panelId].layout, tabId)) {
      return panelId;
    }
  }
  return null;
}

export function createEmptyWorkbenchSessionView(
  sessionId: string,
  options: {
    identityFactory?: WorkbenchSessionViewIdentityFactory;
    touchedAt?: string;
  } = {},
): WorkbenchSessionViewSnapshot {
  const identityFactory = options.identityFactory ?? defaultIdentityFactory();
  return {
    version: WORKBENCH_SESSION_VIEW_VERSION,
    sessionId,
    tabsById: {},
    panels: {
      right: createPanel("right", true, identityFactory.createId("leaf")),
      bottom: createPanel("bottom", true, identityFactory.createId("leaf")),
    },
    lastFocusedPanelId: null,
    touchedAt: options.touchedAt ?? currentIso(),
  };
}

export function normalizeWorkbenchSessionView(
  value: WorkbenchSessionViewSnapshot,
): WorkbenchSessionViewSnapshot {
  const tabEntries = Object.entries(value.tabsById)
    .filter(([id, tab]) => id === tab.id)
    .slice(0, WORKBENCH_SESSION_VIEW_MAX_TABS);
  const tabsById = Object.fromEntries(tabEntries);
  const knownTabIds = new Set(Object.keys(tabsById));
  const seenTabIds = new Set<string>();
  const panels = {} as Record<WorkbenchPanelId, WorkbenchPanelState>;

  for (const panelId of PANEL_IDS) {
    const panel = value.panels[panelId];
    const repaired = removeDuplicateAndUnknownTabIds(panel.layout, knownTabIds, seenTabIds);
    const placedTabIds = flattenWorkbenchPanelTabIds(repaired);
    panels[panelId] = {
      collapsed: panel.collapsed,
      layout: normalizeWorkbenchPanelLayout(repaired, placedTabIds),
      size: normalizePanelSize(panelId, panel.size),
    };
  }

  const unplacedTabIds = Object.keys(tabsById).filter((tabId) => !seenTabIds.has(tabId));
  for (const tabId of unplacedTabIds) {
    panels.right = {
      ...panels.right,
      layout: moveWorkbenchPanelTab(panels.right.layout, { tabId }),
    };
  }

  const lastFocusedPanelId =
    value.lastFocusedPanelId && !panels[value.lastFocusedPanelId].collapsed
      ? value.lastFocusedPanelId
      : null;
  return {
    version: WORKBENCH_SESSION_VIEW_VERSION,
    sessionId: value.sessionId,
    tabsById,
    panels,
    lastFocusedPanelId,
    touchedAt: value.touchedAt,
  };
}

export function materializeInitialWorkbenchSessionView(
  session: WorkbenchSessionMaterializationTarget,
  options: {
    identityFactory?: WorkbenchSessionViewIdentityFactory;
    touchedAt?: string;
  } = {},
): WorkbenchSessionViewSnapshot {
  const identityFactory = options.identityFactory ?? defaultIdentityFactory();
  const empty = createEmptyWorkbenchSessionView(session.id, {
    identityFactory,
    touchedAt: options.touchedAt,
  });
  if (!session.projectId || !session.databaseViewId) return empty;

  const tabId = identityFactory.createId("tab");
  return createWorkbenchSessionViewTab(
    {
      ...empty,
      panels: {
        ...empty.panels,
        right: {
          ...empty.panels.right,
          collapsed: false,
          size: {
            ...empty.panels.right.size,
            fullWidth: true,
          },
        },
      },
    },
    {
      panelId: "right",
      tab: {
        id: tabId,
        kind: "db_view",
        titleSnapshot: "Database",
        config: {
          projectId: session.projectId,
          databaseViewId: session.databaseViewId,
        },
        stateKey: 0,
        state: null,
      },
    },
  );
}

export function createWorkbenchSessionViewTab(
  view: WorkbenchSessionViewSnapshot,
  input: WorkbenchSessionViewTabCreateInput,
): WorkbenchSessionViewSnapshot {
  if (view.tabsById[input.tab.id]) return view;
  if (Object.keys(view.tabsById).length >= WORKBENCH_SESSION_VIEW_MAX_TABS) return view;

  const panel = view.panels[input.panelId];
  const presentation = input.presentation ?? "activate";
  const layout =
    presentation === "background"
      ? insertWorkbenchPanelTabInBackground(panel.layout, {
          tabId: input.tab.id,
          targetLeafId: input.targetLeafId,
          targetIndex: input.targetIndex,
        })
      : moveWorkbenchPanelTab(panel.layout, {
          tabId: input.tab.id,
          targetLeafId: input.targetLeafId,
          targetIndex: input.targetIndex,
        });
  return normalizeWorkbenchSessionView(
    touch({
      ...view,
      tabsById: {
        ...view.tabsById,
        [input.tab.id]: input.tab,
      },
      panels: {
        ...view.panels,
        [input.panelId]: {
          ...panel,
          collapsed: presentation === "background" ? panel.collapsed : false,
          layout,
        },
      },
      lastFocusedPanelId: presentation === "background" ? view.lastFocusedPanelId : input.panelId,
    }),
  );
}

export function updateWorkbenchSessionViewTab(
  view: WorkbenchSessionViewSnapshot,
  tabId: string,
  patch: Partial<Omit<WorkbenchSessionViewTab, "id" | "kind">>,
): WorkbenchSessionViewSnapshot {
  const tab = view.tabsById[tabId];
  if (!tab) return view;
  const nextTab = { ...tab, ...patch, id: tab.id, kind: tab.kind } as WorkbenchSessionViewTab;
  return touch({
    ...view,
    tabsById: {
      ...view.tabsById,
      [tabId]: nextTab,
    },
  });
}

export function removeWorkbenchSessionViewTab(
  view: WorkbenchSessionViewSnapshot,
  tabId: string,
  options: WorkbenchSessionViewTabRemoveOptions = {},
): WorkbenchSessionViewSnapshot {
  if (!view.tabsById[tabId]) return view;
  const tabsById = { ...view.tabsById };
  delete tabsById[tabId];
  const panels = { ...view.panels };
  for (const panelId of PANEL_IDS) {
    const panel = panels[panelId];
    const withoutTab = removeWorkbenchPanelTab(panel.layout, tabId, options);
    panels[panelId] = {
      ...panel,
      layout: pruneEmptyWorkbenchPanelLeaves(withoutTab, {
        preserveLeafIds: options.preserveEmptyLeafIds,
        preferredActiveLeafId: options.preferredActiveLeafId,
        preferredActiveTabId: options.preferredActiveTabId,
      }),
    };
  }
  return normalizeWorkbenchSessionView(touch({ ...view, tabsById, panels }));
}

export function activateWorkbenchSessionViewTab(
  view: WorkbenchSessionViewSnapshot,
  panelId: WorkbenchPanelId,
  leafId: string,
  tabId?: string | null,
): WorkbenchSessionViewSnapshot {
  const panel = view.panels[panelId];
  if (!findWorkbenchPanelLeaf(panel.layout, leafId)) return view;
  return normalizeWorkbenchSessionView(
    touch({
      ...view,
      panels: {
        ...view.panels,
        [panelId]: {
          ...panel,
          collapsed: false,
          layout: activateWorkbenchPanelLeaf(panel.layout, leafId, tabId),
        },
      },
      lastFocusedPanelId: panelId,
    }),
  );
}

export function splitWorkbenchSessionViewLeaf(
  view: WorkbenchSessionViewSnapshot,
  input: WorkbenchSessionViewLeafSplitInput,
): WorkbenchSessionViewSnapshot {
  const panel = view.panels[input.panelId];
  const identityFactory = input.identityFactory ?? defaultIdentityFactory();
  const layout = splitWorkbenchPanelLeaf(panel.layout, {
    leafId: input.leafId,
    newLeafId: identityFactory.createId("leaf"),
    newBranchId: identityFactory.createId("branch"),
    side: input.side,
    tabId: input.tabId,
  });
  return normalizeWorkbenchSessionView(
    touch({
      ...view,
      panels: {
        ...view.panels,
        [input.panelId]: { ...panel, collapsed: false, layout },
      },
      lastFocusedPanelId: input.panelId,
    }),
  );
}

export function ensureWorkbenchSessionViewLeafToRight(
  view: WorkbenchSessionViewSnapshot,
  input: WorkbenchSessionViewLeafInput & {
    identityFactory?: WorkbenchSessionViewIdentityFactory;
  },
): { view: WorkbenchSessionViewSnapshot; leafId: string; created: boolean } {
  const panel = view.panels[input.panelId];
  const sourceLeaf = findWorkbenchPanelLeaf(panel.layout, input.leafId);
  if (!sourceLeaf) return { view, leafId: input.leafId, created: false };
  const leaves = listWorkbenchPanelLeaves(panel.layout);
  const sourceIndex = leaves.findIndex((leaf) => leaf.id === sourceLeaf.id);
  const existingRightLeaf = leaves[sourceIndex + 1];
  if (existingRightLeaf) {
    return {
      view: activateWorkbenchSessionViewTab(view, input.panelId, existingRightLeaf.id),
      leafId: existingRightLeaf.id,
      created: false,
    };
  }

  const identityFactory = input.identityFactory ?? defaultIdentityFactory();
  const leafId = identityFactory.createId("leaf");
  const layout = insertWorkbenchPanelLeaf(panel.layout, {
    leafId: sourceLeaf.id,
    newLeafId: leafId,
    newBranchId: identityFactory.createId("branch"),
    side: "right",
  });
  return {
    view: normalizeWorkbenchSessionView(
      touch({
        ...view,
        panels: {
          ...view.panels,
          [input.panelId]: { ...panel, collapsed: false, layout },
        },
        lastFocusedPanelId: input.panelId,
      }),
    ),
    leafId,
    created: true,
  };
}

export function mergeWorkbenchSessionViewLeaf(
  view: WorkbenchSessionViewSnapshot,
  input: WorkbenchSessionViewLeafInput,
): WorkbenchSessionViewSnapshot {
  const panel = view.panels[input.panelId];
  const layout = mergeWorkbenchPanelLeaf(panel.layout, input.leafId);
  return normalizeWorkbenchSessionView(
    touch({
      ...view,
      panels: {
        ...view.panels,
        [input.panelId]: { ...panel, layout },
      },
    }),
  );
}

export function moveWorkbenchSessionViewTab(
  view: WorkbenchSessionViewSnapshot,
  input: WorkbenchSessionViewTabMoveInput,
): WorkbenchSessionViewSnapshot {
  if (!view.tabsById[input.tabId]) return view;
  const sourcePanelId = panelContainingTab(view, input.tabId);
  if (!sourcePanelId) return view;

  const panels = { ...view.panels };
  const sourcePanel = panels[sourcePanelId];
  panels[sourcePanelId] = {
    ...sourcePanel,
    layout: pruneEmptyWorkbenchPanelLeaves(
      removeWorkbenchPanelTab(sourcePanel.layout, input.tabId),
      { preserveLeafIds: input.preserveEmptyLeafIds },
    ),
  };

  let targetPanel = panels[input.targetPanelId];
  let targetLeafId = input.targetLeafId;
  if (input.splitTarget) {
    const identityFactory = input.identityFactory ?? defaultIdentityFactory();
    targetLeafId = identityFactory.createId("leaf");
    targetPanel = {
      ...targetPanel,
      layout: insertWorkbenchPanelLeaf(targetPanel.layout, {
        leafId: input.splitTarget.leafId,
        newLeafId: targetLeafId,
        newBranchId: identityFactory.createId("branch"),
        side: input.splitTarget.side,
      }),
    };
  }
  panels[input.targetPanelId] = {
    ...targetPanel,
    collapsed: false,
    layout: moveWorkbenchPanelTab(targetPanel.layout, {
      tabId: input.tabId,
      targetLeafId,
      targetIndex: input.targetIndex,
    }),
  };
  return normalizeWorkbenchSessionView(
    touch({
      ...view,
      panels,
      lastFocusedPanelId: input.targetPanelId,
    }),
  );
}

export function reorderWorkbenchSessionViewTabs(
  view: WorkbenchSessionViewSnapshot,
  input: {
    panelId: WorkbenchPanelId;
    leafId: string;
    orderedTabIds: string[];
  },
): WorkbenchSessionViewSnapshot {
  const panel = view.panels[input.panelId];
  return normalizeWorkbenchSessionView(
    touch({
      ...view,
      panels: {
        ...view.panels,
        [input.panelId]: {
          ...panel,
          layout: reorderWorkbenchPanelLeafTabs(panel.layout, input.leafId, input.orderedTabIds),
        },
      },
    }),
  );
}

export function resizeWorkbenchSessionViewBranch(
  view: WorkbenchSessionViewSnapshot,
  input: {
    panelId: WorkbenchPanelId;
    branchId: string;
    ratio: number;
  },
): WorkbenchSessionViewSnapshot {
  const panel = view.panels[input.panelId];
  return normalizeWorkbenchSessionView(
    touch({
      ...view,
      panels: {
        ...view.panels,
        [input.panelId]: {
          ...panel,
          layout: setWorkbenchPanelBranchRatio(panel.layout, input.branchId, input.ratio),
        },
      },
    }),
  );
}

export function maximizeWorkbenchSessionViewLeaf(
  view: WorkbenchSessionViewSnapshot,
  input: {
    panelId: WorkbenchPanelId;
    leafId: string | null;
  },
): WorkbenchSessionViewSnapshot {
  const panel = view.panels[input.panelId];
  return normalizeWorkbenchSessionView(
    touch({
      ...view,
      panels: {
        ...view.panels,
        [input.panelId]: {
          ...panel,
          layout: setWorkbenchPanelMaximizedLeaf(panel.layout, input.leafId),
        },
      },
    }),
  );
}

export function patchWorkbenchSessionViewPanel(
  view: WorkbenchSessionViewSnapshot,
  panelId: WorkbenchPanelId,
  patch: WorkbenchSessionViewPanelPatch,
): WorkbenchSessionViewSnapshot {
  const panel = view.panels[panelId];
  return normalizeWorkbenchSessionView(
    touch({
      ...view,
      panels: {
        ...view.panels,
        [panelId]: {
          ...panel,
          ...(patch.collapsed === undefined ? {} : { collapsed: patch.collapsed }),
          size: {
            ...panel.size,
            ...patch.size,
          },
        },
      },
      lastFocusedPanelId: patch.collapsed === false ? panelId : view.lastFocusedPanelId,
    }),
  );
}

function clonePanelNode(
  node: WorkbenchPanelNode,
  tabIds: ReadonlyMap<string, string>,
  nodeIds: Map<string, string>,
  identityFactory: WorkbenchSessionViewIdentityFactory,
): WorkbenchPanelNode {
  const kind = node.type === "leaf" ? "leaf" : "branch";
  const id = identityFactory.createId(kind);
  nodeIds.set(node.id, id);
  if (node.type === "leaf") {
    return {
      ...node,
      id,
      tabIds: node.tabIds.flatMap((tabId) => {
        const mapped = tabIds.get(tabId);
        return mapped ? [mapped] : [];
      }),
      activeTabId: node.activeTabId ? (tabIds.get(node.activeTabId) ?? null) : null,
      mruTabIds: node.mruTabIds.flatMap((tabId) => {
        const mapped = tabIds.get(tabId);
        return mapped ? [mapped] : [];
      }),
    };
  }
  return {
    ...node,
    id,
    first: clonePanelNode(node.first, tabIds, nodeIds, identityFactory),
    second: clonePanelNode(node.second, tabIds, nodeIds, identityFactory),
  };
}

function cloneSessionView(
  view: WorkbenchSessionViewSnapshot,
  identityFactory: WorkbenchSessionViewIdentityFactory,
): WorkbenchSessionViewSnapshot {
  const tabIds = new Map(
    Object.values(view.tabsById).map((tab) => [
      tab.id,
      tab.kind === "files" && tab.config.path
        ? workbenchFileResourceId(
            tab.config.hostId,
            tab.config.path,
            tab.config.cwd ?? tab.config.workspaceRoot,
          )
        : identityFactory.createId("tab"),
    ]),
  );
  const tabsById = Object.fromEntries(
    Object.values(view.tabsById).map((tab) => {
      const id = tabIds.get(tab.id);
      if (!id) throw new Error(`Missing cloned Workbench tab identity for ${tab.id}`);
      const cloned =
        tab.kind === "browser"
          ? {
              ...tab,
              id,
              config: {
                ...tab.config,
                browserTabId: identityFactory.createId("browser"),
                browserStorageId: identityFactory.createId("browser"),
              },
            }
          : { ...tab, id };
      return [id, cloned];
    }),
  );
  const panels = {} as Record<WorkbenchPanelId, WorkbenchPanelState>;
  for (const panelId of PANEL_IDS) {
    const panel = view.panels[panelId];
    const nodeIds = new Map<string, string>();
    const root = clonePanelNode(panel.layout.root, tabIds, nodeIds, identityFactory);
    panels[panelId] = {
      ...panel,
      layout: {
        ...panel.layout,
        root,
        activeLeafId:
          nodeIds.get(panel.layout.activeLeafId) ??
          listWorkbenchPanelLeaves({ ...panel.layout, root })[0]?.id ??
          identityFactory.createId("leaf"),
        mruLeafIds: panel.layout.mruLeafIds.flatMap((leafId) => {
          const mapped = nodeIds.get(leafId);
          return mapped ? [mapped] : [];
        }),
        maximizedLeafId: panel.layout.maximizedLeafId
          ? (nodeIds.get(panel.layout.maximizedLeafId) ?? null)
          : null,
      },
    };
  }
  return normalizeWorkbenchSessionView({
    ...view,
    tabsById,
    panels,
    touchedAt: currentIso(),
  });
}

export function cloneWorkbenchLayoutForNewWindow<Layout extends CloneWorkbenchLayout>(
  layout: Layout,
  identityFactory: WorkbenchSessionViewIdentityFactory = defaultIdentityFactory(),
): Layout {
  return {
    ...layout,
    sessionViewsBySessionId: Object.fromEntries(
      Object.entries(layout.sessionViewsBySessionId).map(([sessionId, view]) => [
        sessionId,
        cloneSessionView(view, identityFactory),
      ]),
    ),
  };
}

export function reconcileWorkbenchSessionViews<Layout extends CloneWorkbenchLayout>(
  layout: Layout,
  availableSessionIds: ReadonlySet<string>,
): Layout {
  return {
    ...layout,
    sessionViewsBySessionId: Object.fromEntries(
      Object.entries(layout.sessionViewsBySessionId).filter(([sessionId]) =>
        availableSessionIds.has(sessionId),
      ),
    ),
  };
}
