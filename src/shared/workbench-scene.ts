import type { BrowserSidebarDeviceToolbarState } from "./browser-sidebar";
import type { CodexForkBrowserSidePanelSnapshot } from "./codex-fork-browser-transfer";
import type { InitialProjectPresentation } from "./initial-project-welcome";
import { createSecureRuntimeId } from "./secure-runtime-id";
import { contentAccessContextKey, type ContentAccessContext } from "./content-access-context";
import type { DatabaseId } from "./database-identities";
import type { WorkbenchImageEditorSurfaceConfig } from "./workbench-image-editor";
import type { LibraryPlacedResourceTarget } from "./library-module";
import type { WorkbenchReviewConfig } from "./workbench-review";
import {
  activateWorkbenchSessionViewTab,
  cloneWorkbenchLayoutForNewWindow as cloneLegacyWorkbenchLayoutForNewWindow,
  createEmptyWorkbenchSessionView,
  createWorkbenchSessionViewTab,
  ensureWorkbenchSessionViewLeafToRight,
  maximizeWorkbenchSessionViewLeaf,
  mergeWorkbenchSessionViewLeaf,
  moveWorkbenchSessionViewTab,
  normalizeWorkbenchSessionView,
  patchWorkbenchSessionViewPanel,
  removeWorkbenchSessionViewTab,
  reorderWorkbenchSessionViewTabs,
  resizeWorkbenchSessionViewBranch,
  splitWorkbenchSessionViewLeaf,
  updateWorkbenchSessionViewTab,
  WORKBENCH_SESSION_VIEW_VERSION,
  type WorkbenchPanelId,
  type WorkbenchPanelSize,
  type WorkbenchPanelState,
  type WorkbenchSessionViewIdentityFactory,
  type WorkbenchSessionViewSnapshot,
  type WorkbenchSessionViewTab,
  type WorkbenchSurfacePresentation,
} from "./workbench-session-view";
import {
  activateWorkbenchPanelLeaf,
  findWorkbenchPanelLeaf,
  findWorkbenchPanelLeafForTab,
  flattenWorkbenchPanelTabIds,
  getWorkbenchPanelActiveLeaf,
  listWorkbenchPanelLeaves,
  moveWorkbenchPanelTab,
  removeWorkbenchPanelTab,
  reorderWorkbenchPanelLeafTabs,
  type WorkbenchPanelSplitSide,
} from "./workbench-panel-layout";

export const WORKBENCH_SCENE_VERSION = 7 as const;
export const WORKBENCH_SCENE_MAX_PANEL_SURFACES = 2_048;

export type WorkbenchSceneOwner =
  | {
      readonly kind: "project";
      readonly projectId: string;
    }
  | {
      readonly kind: "session";
      readonly sessionId: string;
    }
  | {
      readonly kind: "pages";
    };

export type WorkbenchSceneOwnerV4 =
  | Exclude<WorkbenchSceneOwner, { readonly kind: "pages" }>
  | {
      readonly kind: "resource";
      readonly root: LibraryPlacedResourceTarget;
    };

export type WorkbenchSceneKey = string;

export type WorkbenchAgentDockBinding =
  | { readonly kind: "new" }
  | { readonly kind: "session"; readonly sessionId: string };

export interface WorkbenchAgentDockState {
  readonly binding: WorkbenchAgentDockBinding;
  readonly newDraftId: string;
}

export interface WorkbenchComposerOverlayState {
  readonly visible: boolean;
}

export function makeWorkbenchSceneKey(owner: WorkbenchSceneOwner): WorkbenchSceneKey {
  if (owner.kind === "project") return `project:${owner.projectId}`;
  if (owner.kind === "session") return `session:${owner.sessionId}`;
  return "pages";
}

export type WorkbenchSurfaceKind =
  | "conversation"
  | "db_view"
  | "page_stage"
  | "canvas_stage"
  | "terminal"
  | "browser"
  | "review"
  | "files"
  | "image_editor";

export interface WorkbenchConversationSurfaceConfig {
  readonly sessionId: string;
}

export interface WorkbenchDbViewSurfaceConfig {
  readonly accessContext: ContentAccessContext;
  readonly target:
    | { readonly kind: "project-default" }
    | {
        readonly kind: "database-default";
        readonly databaseId: DatabaseId;
      }
    | {
        readonly kind: "database-view";
        readonly databaseViewId: string;
      };
}

export interface WorkbenchPageStageSurfaceConfig {
  readonly accessContext: ContentAccessContext;
  readonly pageId: string;
  readonly titleSnapshot?: string;
}

export interface WorkbenchCanvasStageSurfaceConfig {
  readonly accessContext: ContentAccessContext;
  readonly canvasBlockId: string;
  readonly titleSnapshot?: string;
}

export interface WorkbenchTerminalSurfaceConfig {
  readonly terminalSessionId: string;
  readonly context?:
    | {
        readonly kind: "project";
        readonly projectId: string;
      }
    | {
        readonly kind: "session";
        readonly sessionId: string;
      };
}

export interface WorkbenchBrowserSurfaceConfig {
  readonly browserTabId: string;
  readonly browserUseSource?: {
    readonly codexSessionId: string;
  };
  readonly browserStorageId?: string;
  readonly url?: string;
  readonly title?: string;
  readonly faviconUrl?: string;
  readonly deviceToolbarVisible?: boolean;
  readonly deviceToolbarState?: BrowserSidebarDeviceToolbarState;
}

export type WorkbenchReviewSurfaceConfig = WorkbenchReviewConfig;

export interface WorkbenchFilesSurfaceConfig {
  readonly projectId: string | null;
  readonly hostId: "local";
  readonly workspaceRoot: string | null;
  readonly cwd: string | null;
  readonly path?: string;
}

export interface WorkbenchSurfaceConfigByKind {
  readonly conversation: WorkbenchConversationSurfaceConfig;
  readonly db_view: WorkbenchDbViewSurfaceConfig;
  readonly page_stage: WorkbenchPageStageSurfaceConfig;
  readonly canvas_stage: WorkbenchCanvasStageSurfaceConfig;
  readonly terminal: WorkbenchTerminalSurfaceConfig;
  readonly browser: WorkbenchBrowserSurfaceConfig;
  readonly review: WorkbenchReviewSurfaceConfig;
  readonly files: WorkbenchFilesSurfaceConfig;
  readonly image_editor: WorkbenchImageEditorSurfaceConfig;
}

type WorkbenchSurfaceVariant = {
  [Kind in WorkbenchSurfaceKind]: {
    readonly kind: Kind;
    readonly config: WorkbenchSurfaceConfigByKind[Kind];
  };
}[WorkbenchSurfaceKind];

export type WorkbenchSurfaceDescriptor = {
  readonly id: string;
  readonly titleSnapshot: string;
  readonly stateKey: number;
  readonly state: unknown;
} & WorkbenchSurfaceVariant;

export interface WorkbenchSceneSnapshot {
  readonly version: typeof WORKBENCH_SCENE_VERSION;
  readonly owner: WorkbenchSceneOwner;
  readonly primary: WorkbenchSurfaceDescriptor | null;
  readonly panelSurfacesById: Readonly<Record<string, WorkbenchSurfaceDescriptor>>;
  readonly panels: Readonly<Record<WorkbenchPanelId, WorkbenchPanelState>>;
  readonly lastFocusedPanelId: WorkbenchPanelId | null;
  readonly composerOverlay: WorkbenchComposerOverlayState;
  readonly agentDock: WorkbenchAgentDockState | null;
  readonly touchedAt: string;
}

export interface WorkbenchSceneSnapshotV4 {
  readonly version: 4;
  readonly owner: WorkbenchSceneOwnerV4;
  readonly primary: WorkbenchSurfaceDescriptor;
  readonly panelSurfacesById: Readonly<Record<string, WorkbenchSurfaceDescriptor>>;
  readonly panels: Readonly<Record<WorkbenchPanelId, WorkbenchPanelState>>;
  readonly lastFocusedPanelId: WorkbenchPanelId | null;
  readonly composerOverlay: WorkbenchComposerOverlayState;
  readonly agentDock: WorkbenchAgentDockState | null;
  readonly touchedAt: string;
}

type WorkbenchLegacyResourceSurfaceDescriptor =
  | (Omit<Extract<WorkbenchSurfaceDescriptor, { readonly kind: "db_view" }>, "config"> & {
      readonly config: {
        readonly projectId: string;
        readonly target:
          | { readonly kind: "project-default" }
          | {
              readonly kind: "database-view";
              readonly databaseViewId: string;
            };
        readonly view: "board" | "list" | "toggle-list" | "calendar";
      };
    })
  | (Omit<Extract<WorkbenchSurfaceDescriptor, { readonly kind: "page_stage" }>, "config"> & {
      readonly config: Omit<WorkbenchPageStageSurfaceConfig, "accessContext"> & {
        readonly projectId: string;
      };
    })
  | (Omit<Extract<WorkbenchSurfaceDescriptor, { readonly kind: "canvas_stage" }>, "config"> & {
      readonly config: Omit<WorkbenchCanvasStageSurfaceConfig, "accessContext"> & {
        readonly projectId: string;
      };
    });

export type WorkbenchSurfaceDescriptorV3 =
  | Exclude<
      WorkbenchSurfaceDescriptor,
      {
        readonly kind: "db_view" | "page_stage" | "canvas_stage" | "image_editor";
      }
    >
  | WorkbenchLegacyResourceSurfaceDescriptor;

export interface WorkbenchSceneSnapshotV3 {
  readonly version: 3;
  readonly owner: Exclude<WorkbenchSceneOwner, { readonly kind: "pages" }>;
  readonly primary: WorkbenchSurfaceDescriptorV3;
  readonly panelSurfacesById: Readonly<Record<string, WorkbenchSurfaceDescriptorV3>>;
  readonly panels: Readonly<Record<WorkbenchPanelId, WorkbenchPanelState>>;
  readonly lastFocusedPanelId: WorkbenchPanelId | null;
  readonly composerOverlay: WorkbenchComposerOverlayState;
  readonly agentDock: WorkbenchAgentDockState | null;
  readonly touchedAt: string;
}

export type WorkbenchSceneSnapshotV2 = Omit<
  WorkbenchSceneSnapshotV3,
  "version" | "composerOverlay" | "agentDock"
> & {
  readonly version: 2;
  readonly agentDock:
    | (WorkbenchAgentDockState & {
        readonly visible: boolean;
      })
    | null;
};

export type WorkbenchSceneSnapshotV1 = Omit<WorkbenchSceneSnapshotV2, "version" | "agentDock"> & {
  readonly version: 1;
};

export interface WorkbenchSceneIdentityFactory {
  createId(kind: "surface" | "leaf" | "branch" | "browser" | "draft"): string;
}

export interface WorkbenchSceneSurfaceCreateInput {
  readonly panelId: WorkbenchPanelId;
  readonly presentation?: WorkbenchSurfacePresentation;
  readonly targetLeafId?: string;
  readonly targetIndex?: number;
  readonly surface: WorkbenchSurfaceDescriptor;
}

export interface WorkbenchSceneSurfaceRemoveOptions {
  readonly preserveEmptyLeafIds?: string[];
  readonly preferredActiveLeafId?: string | null;
  readonly preferredActiveSurfaceId?: string | null;
}

export interface WorkbenchSceneSurfaceMoveInput {
  readonly surfaceId: string;
  readonly targetPanelId: WorkbenchPanelId;
  readonly targetLeafId?: string;
  readonly targetIndex?: number;
  readonly preserveEmptyLeafIds?: string[];
  readonly splitTarget?: {
    readonly leafId: string;
    readonly side: WorkbenchPanelSplitSide;
  };
  readonly identityFactory?: WorkbenchSceneIdentityFactory;
}

export interface WorkbenchSceneLeafInput {
  readonly panelId: WorkbenchPanelId;
  readonly leafId: string;
}

export interface WorkbenchSceneLeafSplitInput extends WorkbenchSceneLeafInput {
  readonly side: WorkbenchPanelSplitSide;
  readonly surfaceId?: string;
  readonly identityFactory?: WorkbenchSceneIdentityFactory;
}

export interface WorkbenchScenePanelPatch {
  readonly collapsed?: boolean;
  readonly size?: Partial<WorkbenchPanelSize>;
}

export interface CloneWorkbenchSceneLayout {
  readonly scenesByOwnerKey: Readonly<Record<WorkbenchSceneKey, WorkbenchSceneSnapshot>>;
}

function currentIso(): string {
  return new Date().toISOString();
}

function defaultIdentityFactory(): WorkbenchSceneIdentityFactory {
  return {
    createId(kind) {
      return createSecureRuntimeId(kind);
    },
  };
}

function toLegacyIdentityFactory(
  identityFactory: WorkbenchSceneIdentityFactory,
): WorkbenchSessionViewIdentityFactory {
  return {
    createId(kind) {
      return identityFactory.createId(kind === "tab" ? "surface" : kind);
    },
  };
}

const PANEL_IDS = ["right", "bottom"] as const satisfies readonly WorkbenchPanelId[];

function isSurfacePlaced(
  scene: Pick<WorkbenchSceneSnapshot, "panels">,
  surfaceId: string,
): boolean {
  return PANEL_IDS.some((panelId) =>
    flattenWorkbenchPanelTabIds(scene.panels[panelId].layout).includes(surfaceId),
  );
}

function toLegacyPanelView(scene: WorkbenchSceneSnapshot): WorkbenchSessionViewSnapshot {
  const tabsById =
    scene.primary && isSurfacePlaced(scene, scene.primary.id)
      ? {
          ...scene.panelSurfacesById,
          [scene.primary.id]: scene.primary,
        }
      : scene.panelSurfacesById;
  return {
    version: WORKBENCH_SESSION_VIEW_VERSION,
    sessionId: makeWorkbenchSceneKey(scene.owner),
    tabsById: tabsById as Record<string, WorkbenchSessionViewTab>,
    panels: scene.panels as Record<WorkbenchPanelId, WorkbenchPanelState>,
    lastFocusedPanelId: scene.lastFocusedPanelId,
    touchedAt: scene.touchedAt,
  };
}

function enforceProjectSceneInvariants(scene: WorkbenchSceneSnapshot): WorkbenchSceneSnapshot {
  if (!scene.primary) return scene;
  const panelSurfacesById = Object.fromEntries(
    Object.entries(scene.panelSurfacesById).filter(([, surface]) =>
      isProjectScenePanelSurfaceAllowed(surface),
    ),
  );
  const knownIds = new Set([scene.primary.id, ...Object.keys(panelSurfacesById)]);
  let rightLayout = scene.panels.right.layout;
  let bottomLayout = removeWorkbenchPanelTab(scene.panels.bottom.layout, scene.primary.id);

  for (const panelId of PANEL_IDS) {
    const layout = panelId === "right" ? rightLayout : bottomLayout;
    for (const surfaceId of flattenWorkbenchPanelTabIds(layout)) {
      if (knownIds.has(surfaceId)) continue;
      if (panelId === "right") {
        rightLayout = removeWorkbenchPanelTab(rightLayout, surfaceId);
      } else {
        bottomLayout = removeWorkbenchPanelTab(bottomLayout, surfaceId);
      }
    }
  }

  let rootLeaf = findWorkbenchPanelLeafForTab(rightLayout, scene.primary.id);
  if (!rootLeaf) {
    const targetLeaf = getWorkbenchPanelActiveLeaf(rightLayout);
    rightLayout = moveWorkbenchPanelTab(rightLayout, {
      tabId: scene.primary.id,
      targetLeafId: targetLeaf.id,
      targetIndex: 0,
    });
    rootLeaf = findWorkbenchPanelLeafForTab(rightLayout, scene.primary.id);
  }
  if (rootLeaf) {
    const primaryId = scene.primary.id;
    rightLayout = reorderWorkbenchPanelLeafTabs(rightLayout, rootLeaf.id, [
      primaryId,
      ...rootLeaf.tabIds.filter((surfaceId) => surfaceId !== primaryId),
    ]);
  }

  return {
    ...scene,
    panelSurfacesById,
    panels: {
      right: {
        ...scene.panels.right,
        collapsed: false,
        layout: rightLayout,
        size: {
          ...scene.panels.right.size,
          fullWidth: true,
        },
      },
      bottom: {
        ...scene.panels.bottom,
        layout: bottomLayout,
      },
    },
    lastFocusedPanelId:
      scene.lastFocusedPanelId === "right" || scene.lastFocusedPanelId === "bottom"
        ? scene.lastFocusedPanelId
        : null,
    agentDock: scene.agentDock ?? {
      binding: { kind: "new" },
      newDraftId: `agent-draft:${scene.primary.id}`,
    },
  };
}

function enforceSessionSceneInvariants(scene: WorkbenchSceneSnapshot): WorkbenchSceneSnapshot {
  if (!scene.primary) return scene;
  const panelSurfacesById = Object.fromEntries(
    Object.entries(scene.panelSurfacesById).filter(
      ([, surface]) => surface.kind !== "conversation",
    ),
  );
  const knownIds = new Set(Object.keys(panelSurfacesById));
  const panels = { ...scene.panels };
  for (const panelId of PANEL_IDS) {
    let layout = panels[panelId].layout;
    for (const surfaceId of flattenWorkbenchPanelTabIds(layout)) {
      if (knownIds.has(surfaceId)) continue;
      layout = removeWorkbenchPanelTab(layout, surfaceId);
    }
    panels[panelId] = {
      ...panels[panelId],
      layout: removeWorkbenchPanelTab(layout, scene.primary.id),
    };
  }
  return {
    ...scene,
    panelSurfacesById,
    panels,
    agentDock: null,
  };
}

/** Removes Review surfaces when a Session has no attached Thread to review. */
export function enforceWorkbenchSessionReviewEligibility(
  scene: WorkbenchSceneSnapshot,
  hasAttachedThread: boolean,
): WorkbenchSceneSnapshot {
  if (scene.owner.kind !== "session" || hasAttachedThread) return scene;

  const reviewSurfaceIds = Object.values(scene.panelSurfacesById)
    .filter((surface) => surface.kind === "review")
    .map((surface) => surface.id);
  if (reviewSurfaceIds.length === 0) return scene;

  const eligibleScene = reviewSurfaceIds.reduce(
    (current, surfaceId) => removeWorkbenchSceneSurface(current, surfaceId),
    scene,
  );
  return { ...eligibleScene, touchedAt: scene.touchedAt };
}

export function isPagesSceneSurfaceAllowed(surface: WorkbenchSurfaceDescriptor): boolean {
  if (surface.kind === "page_stage" || surface.kind === "canvas_stage") {
    return surface.config.accessContext.kind === "library";
  }
  return (
    surface.kind === "db_view" &&
    surface.config.accessContext.kind === "library" &&
    surface.config.target.kind !== "project-default"
  );
}

export function isProjectScenePanelSurfaceAllowed(surface: WorkbenchSurfaceDescriptor): boolean {
  return surface.kind !== "conversation" && surface.kind !== "review";
}

export function isWorkbenchScenePanelSurfaceAllowed(
  owner: WorkbenchSceneOwner,
  surface: WorkbenchSurfaceDescriptor,
): boolean {
  if (owner.kind === "project") return isProjectScenePanelSurfaceAllowed(surface);
  if (owner.kind === "pages") return isPagesSceneSurfaceAllowed(surface);
  return surface.kind !== "conversation";
}

function enforcePagesSceneInvariants(scene: WorkbenchSceneSnapshot): WorkbenchSceneSnapshot {
  const panelSurfacesById = Object.fromEntries(
    Object.entries(scene.panelSurfacesById).filter(([, surface]) =>
      isPagesSceneSurfaceAllowed(surface),
    ),
  );
  const knownIds = new Set(Object.keys(panelSurfacesById));
  const panels = { ...scene.panels };
  for (const panelId of PANEL_IDS) {
    let layout = panels[panelId].layout;
    for (const surfaceId of flattenWorkbenchPanelTabIds(layout)) {
      if (knownIds.has(surfaceId)) continue;
      layout = removeWorkbenchPanelTab(layout, surfaceId);
    }
    panels[panelId] = { ...panels[panelId], layout };
  }
  return {
    ...scene,
    primary: null,
    panelSurfacesById,
    panels: {
      ...panels,
      right: {
        ...panels.right,
        collapsed: false,
        size: {
          ...panels.right.size,
          fullWidth: true,
        },
      },
    },
    composerOverlay: { visible: false },
    agentDock: null,
  };
}

function enforceWorkbenchSceneInvariants(scene: WorkbenchSceneSnapshot): WorkbenchSceneSnapshot {
  if (scene.owner.kind === "project") {
    return enforceProjectSceneInvariants(scene);
  }
  if (scene.owner.kind === "pages") {
    return enforcePagesSceneInvariants(scene);
  }
  return enforceSessionSceneInvariants(scene);
}

function fromLegacyPanelView(
  scene: WorkbenchSceneSnapshot,
  view: WorkbenchSessionViewSnapshot,
): WorkbenchSceneSnapshot {
  const primary =
    scene.primary && view.tabsById[scene.primary.id]
      ? (view.tabsById[scene.primary.id] as WorkbenchSurfaceDescriptor)
      : scene.primary;
  const panelSurfacesById = { ...view.tabsById } as Record<string, WorkbenchSurfaceDescriptor>;
  if (primary) delete panelSurfacesById[primary.id];
  return enforceWorkbenchSceneInvariants({
    ...scene,
    primary,
    panelSurfacesById,
    panels: view.panels,
    lastFocusedPanelId: view.lastFocusedPanelId,
    touchedAt: view.touchedAt,
  });
}

export function resolveWorkbenchSceneSurface(
  scene: WorkbenchSceneSnapshot,
  surfaceId: string,
): WorkbenchSurfaceDescriptor | undefined {
  return surfaceId === scene.primary?.id ? scene.primary : scene.panelSurfacesById[surfaceId];
}

/**
 * Page identities currently presented by visible Page Stage surfaces.
 *
 * Presence follows rendered panel geometry: collapsed panels, background
 * tabs, and leaves hidden by panel maximization do not contribute. Page IDs
 * are Library-global identities, so consumers can match this one projection
 * against any authorized Database View without duplicating it per Project.
 */
export function collectWorkbenchScenePresentedPageIds(
  scene: WorkbenchSceneSnapshot,
): ReadonlySet<string> {
  const pageIds = new Set<string>();

  for (const panelId of PANEL_IDS) {
    const panel = scene.panels[panelId];
    if (panel.collapsed) continue;

    const leaves = panel.layout.maximizedLeafId
      ? [findWorkbenchPanelLeaf(panel.layout, panel.layout.maximizedLeafId)]
      : listWorkbenchPanelLeaves(panel.layout);
    for (const leaf of leaves) {
      if (!leaf?.activeTabId) continue;
      const surface = resolveWorkbenchSceneSurface(scene, leaf.activeTabId);
      if (surface?.kind !== "page_stage") continue;
      pageIds.add(surface.config.pageId);
    }
  }

  return pageIds;
}

function toLegacyPanelTab(surface: WorkbenchSurfaceDescriptor): WorkbenchSessionViewTab {
  if (surface.kind !== "db_view") {
    return surface as WorkbenchSessionViewTab;
  }
  if (surface.config.target.kind !== "database-view") {
    throw new Error(
      "A symbolic Project Database surface cannot be projected as a legacy Session tab",
    );
  }
  return {
    ...surface,
    config: {
      projectId:
        surface.config.accessContext.kind === "project"
          ? surface.config.accessContext.projectId
          : (() => {
              throw new Error(
                "A Library Database surface cannot be projected as a legacy Session tab",
              );
            })(),
      databaseViewId: surface.config.target.databaseViewId,
    },
  };
}

/**
 * Decode-only bridge for descriptors that were authored through the v1-v4
 * Session panel vocabulary. Runtime layout ownership remains the Scene.
 */
export function workbenchSurfaceFromLegacySessionTab(
  tab: WorkbenchSessionViewTab,
): WorkbenchSurfaceDescriptor {
  if (tab.kind !== "db_view") return tab as WorkbenchSurfaceDescriptor;
  return {
    ...tab,
    config: {
      accessContext: { kind: "project", projectId: tab.config.projectId },
      target: {
        kind: "database-view",
        databaseViewId: tab.config.databaseViewId,
      },
    },
  };
}

/**
 * Temporary compatibility projection while leaf renderers move from Session
 * views to Scene surfaces. The returned value is never a second authority.
 */
export function projectWorkbenchSceneToLegacySessionView(
  scene: WorkbenchSceneSnapshot,
): WorkbenchSessionViewSnapshot {
  if (scene.owner.kind !== "session") {
    throw new Error("Only a Session Scene has a legacy Session view projection");
  }
  return {
    ...toLegacyPanelView(scene),
    sessionId: scene.owner.sessionId,
    tabsById: Object.fromEntries(
      Object.entries(scene.panelSurfacesById).map(([surfaceId, surface]) => [
        surfaceId,
        toLegacyPanelTab(surface),
      ]),
    ),
  };
}

export function applyLegacySessionViewToWorkbenchScene(
  scene: WorkbenchSceneSnapshot,
  view: WorkbenchSessionViewSnapshot,
): WorkbenchSceneSnapshot {
  if (scene.owner.kind !== "session" || scene.owner.sessionId !== view.sessionId) {
    return scene;
  }
  const panelSurfacesById = Object.fromEntries(
    Object.entries(view.tabsById).map(([surfaceId, tab]) => [
      surfaceId,
      workbenchSurfaceFromLegacySessionTab(tab),
    ]),
  );
  return normalizeWorkbenchScene({
    ...scene,
    panelSurfacesById,
    panels: view.panels,
    lastFocusedPanelId: view.lastFocusedPanelId,
    touchedAt: view.touchedAt,
  });
}

function ownerRootPrimary(
  owner: WorkbenchSceneOwner,
  identityFactory: WorkbenchSceneIdentityFactory,
): WorkbenchSurfaceDescriptor | null {
  if (owner.kind === "project") {
    return {
      id: identityFactory.createId("surface"),
      kind: "db_view",
      titleSnapshot: "Database",
      config: {
        accessContext: { kind: "project", projectId: owner.projectId },
        target: { kind: "project-default" },
      },
      stateKey: 0,
      state: null,
    };
  }

  if (owner.kind === "session")
    return {
      id: identityFactory.createId("surface"),
      kind: "conversation",
      titleSnapshot: "Conversation",
      config: { sessionId: owner.sessionId },
      stateKey: 0,
      state: null,
    };

  return null;
}

export function createEmptyWorkbenchScene(
  owner: WorkbenchSceneOwner,
  options: {
    readonly identityFactory?: WorkbenchSceneIdentityFactory;
    readonly touchedAt?: string;
  } = {},
): WorkbenchSceneSnapshot {
  const identityFactory = options.identityFactory ?? defaultIdentityFactory();
  const view = createEmptyWorkbenchSessionView(makeWorkbenchSceneKey(owner), {
    identityFactory: toLegacyIdentityFactory(identityFactory),
    touchedAt: options.touchedAt,
  });
  return normalizeWorkbenchScene({
    version: WORKBENCH_SCENE_VERSION,
    owner,
    primary: ownerRootPrimary(owner, identityFactory),
    panelSurfacesById: {},
    panels: view.panels,
    lastFocusedPanelId: null,
    composerOverlay: { visible: owner.kind !== "pages" },
    agentDock:
      owner.kind === "project"
        ? {
            binding: { kind: "new" },
            newDraftId: identityFactory.createId("draft"),
          }
        : null,
    touchedAt: view.touchedAt,
  });
}

export function materializeInitialWorkbenchScene(
  owner: WorkbenchSceneOwner,
  options: {
    readonly identityFactory?: WorkbenchSceneIdentityFactory;
    readonly touchedAt?: string;
  } = {},
): WorkbenchSceneSnapshot {
  return createEmptyWorkbenchScene(owner, options);
}

export function materializeInitialProjectWelcomeScene(
  presentation: InitialProjectPresentation,
  options: { readonly touchedAt?: string } = {},
): WorkbenchSceneSnapshot {
  const counters = new Map<string, number>();
  const identityFactory: WorkbenchSceneIdentityFactory = {
    createId(kind) {
      const ordinal = counters.get(kind) ?? 0;
      counters.set(kind, ordinal + 1);
      return `initial:${presentation.projectId}:${kind}:${ordinal}`;
    },
  };
  const initial = materializeInitialWorkbenchScene(
    { kind: "project", projectId: presentation.projectId },
    {
      identityFactory,
      touchedAt: options.touchedAt,
    },
  );
  const surfaceId = identityFactory.createId("surface");
  const withPage = createWorkbenchSceneSurface(initial, {
    panelId: "right",
    surface: {
      id: surfaceId,
      kind: "page_stage",
      titleSnapshot: presentation.starterPageTitle,
      config: {
        accessContext: {
          kind: "project",
          projectId: presentation.projectId,
        },
        pageId: presentation.starterPageId,
        titleSnapshot: presentation.starterPageTitle,
      },
      stateKey: 0,
      state: null,
    },
  });
  const maximized = patchWorkbenchScenePanel(withPage, "right", {
    collapsed: false,
    size: { fullWidth: true },
  });
  return options.touchedAt ? { ...maximized, touchedAt: options.touchedAt } : maximized;
}

export function normalizeWorkbenchScene(value: WorkbenchSceneSnapshot): WorkbenchSceneSnapshot {
  const normalized = normalizeWorkbenchSessionView(toLegacyPanelView(value));
  return fromLegacyPanelView(value, normalized);
}

function migrateWorkbenchSurfaceV3ToV4(
  surface: WorkbenchSurfaceDescriptorV3,
): WorkbenchSurfaceDescriptor {
  if (
    surface.kind !== "db_view" &&
    surface.kind !== "page_stage" &&
    surface.kind !== "canvas_stage"
  ) {
    return surface;
  }
  if (surface.kind === "db_view") {
    const { projectId, view: legacyLayout, ...config } = surface.config;
    void legacyLayout;
    return {
      ...surface,
      config: {
        ...config,
        accessContext: { kind: "project", projectId },
      },
    };
  }
  const { projectId, ...config } = surface.config;
  return {
    ...surface,
    config: {
      ...config,
      accessContext: { kind: "project", projectId },
    },
  } as WorkbenchSurfaceDescriptor;
}

function migrateLegacySceneBase(input: {
  readonly legacy: Omit<WorkbenchSceneSnapshotV3, "version" | "composerOverlay" | "agentDock">;
  readonly composerOverlay: WorkbenchComposerOverlayState;
  readonly agentDock: WorkbenchAgentDockState | null;
}): WorkbenchSceneSnapshotV4 {
  const current = normalizeWorkbenchScene({
    ...input.legacy,
    version: WORKBENCH_SCENE_VERSION,
    primary: migrateWorkbenchSurfaceV3ToV4(input.legacy.primary),
    panelSurfacesById: Object.fromEntries(
      Object.entries(input.legacy.panelSurfacesById).map(([surfaceId, surface]) => [
        surfaceId,
        migrateWorkbenchSurfaceV3ToV4(surface),
      ]),
    ),
    composerOverlay: input.composerOverlay,
    agentDock: input.agentDock,
  });
  if (!current.primary) {
    throw new Error("Legacy Project and Session Scenes require a primary");
  }
  return {
    ...current,
    version: 4,
    owner: input.legacy.owner,
    primary: current.primary,
  };
}

export function migrateWorkbenchSceneV3ToV4(
  legacy: WorkbenchSceneSnapshotV3,
): WorkbenchSceneSnapshotV4 {
  const { composerOverlay, agentDock, ...scene } = legacy;
  return migrateLegacySceneBase({
    legacy: scene,
    composerOverlay,
    agentDock,
  });
}

export function migrateWorkbenchSceneV2ToV4(
  legacy: WorkbenchSceneSnapshotV2,
): WorkbenchSceneSnapshotV4 {
  const { agentDock: legacyAgentDock, ...scene } = legacy;
  return migrateLegacySceneBase({
    legacy: scene,
    composerOverlay: {
      visible: legacy.owner.kind === "project" ? (legacyAgentDock?.visible ?? true) : true,
    },
    agentDock: legacyAgentDock
      ? {
          binding: legacyAgentDock.binding,
          newDraftId: legacyAgentDock.newDraftId,
        }
      : null,
  });
}

/**
 * Pure Scene-v1 migration. Project Conversation surfaces become a Dock
 * binding; their Sessions remain owned by Core.
 */
export function migrateWorkbenchSceneV1ToV4(
  legacy: WorkbenchSceneSnapshotV1,
): WorkbenchSceneSnapshotV4 {
  if (legacy.owner.kind === "session") {
    return migrateLegacySceneBase({
      legacy,
      composerOverlay: { visible: true },
      agentDock: null,
    });
  }

  const rightWasCollapsed = legacy.panels.right.collapsed;
  const activeLeaf = getWorkbenchPanelActiveLeaf(legacy.panels.right.layout);
  const activeSurface = activeLeaf.activeTabId
    ? legacy.panelSurfacesById[activeLeaf.activeTabId]
    : undefined;
  const boundSessionId =
    activeSurface?.kind === "conversation" ? activeSurface.config.sessionId : null;
  const migrated = migrateLegacySceneBase({
    legacy,
    composerOverlay: { visible: true },
    agentDock: {
      binding: boundSessionId ? { kind: "session", sessionId: boundSessionId } : { kind: "new" },
      newDraftId: `agent-draft:${legacy.primary.id}`,
    },
  });

  if (!rightWasCollapsed && !boundSessionId) return migrated;
  if (!migrated.primary) return migrated;
  const rootLeaf = findWorkbenchPanelLeafForTab(migrated.panels.right.layout, migrated.primary.id);
  if (!rootLeaf) return migrated;
  return {
    ...migrated,
    panels: {
      ...migrated.panels,
      right: {
        ...migrated.panels.right,
        layout: activateWorkbenchPanelLeaf(
          migrated.panels.right.layout,
          rootLeaf.id,
          migrated.primary.id,
        ),
      },
    },
    lastFocusedPanelId: "right",
  };
}

/** Migrates the former per-resource Scene model into the shared Pages Scene. */
export function migrateWorkbenchSceneV4ToV5(
  legacy: WorkbenchSceneSnapshotV4,
): WorkbenchSceneSnapshot {
  if (legacy.owner.kind !== "resource") {
    return normalizeWorkbenchScene({
      ...legacy,
      version: WORKBENCH_SCENE_VERSION,
      owner: legacy.owner,
    });
  }
  const retainedSiblings = Object.entries(legacy.panelSurfacesById)
    .filter(([, surface]) => isPagesSceneSurfaceAllowed(surface))
    .slice(0, WORKBENCH_SCENE_MAX_PANEL_SURFACES - 1);
  return normalizeWorkbenchScene({
    ...legacy,
    version: WORKBENCH_SCENE_VERSION,
    owner: { kind: "pages" },
    primary: null,
    panelSurfacesById: {
      [legacy.primary.id]: legacy.primary,
      ...Object.fromEntries(retainedSiblings),
    },
    composerOverlay: { visible: false },
    agentDock: null,
  });
}

export function createWorkbenchSceneSurface(
  scene: WorkbenchSceneSnapshot,
  input: WorkbenchSceneSurfaceCreateInput,
): WorkbenchSceneSnapshot {
  if (!isWorkbenchScenePanelSurfaceAllowed(scene.owner, input.surface)) return scene;
  if (input.surface.id === scene.primary?.id || scene.panelSurfacesById[input.surface.id]) {
    return scene;
  }
  const view = createWorkbenchSessionViewTab(toLegacyPanelView(scene), {
    panelId: input.panelId,
    presentation: input.presentation,
    targetLeafId: input.targetLeafId,
    targetIndex: input.targetIndex,
    tab: input.surface as WorkbenchSessionViewTab,
  });
  return fromLegacyPanelView(scene, view);
}

export function updateWorkbenchSceneSurface(
  scene: WorkbenchSceneSnapshot,
  surfaceId: string,
  patch: Partial<Omit<WorkbenchSurfaceDescriptor, "id" | "kind">>,
): WorkbenchSceneSnapshot {
  if (surfaceId === scene.primary?.id && scene.primary) {
    return {
      ...scene,
      primary: {
        ...scene.primary,
        ...patch,
        id: scene.primary.id,
        kind: scene.primary.kind,
      } as WorkbenchSurfaceDescriptor,
      touchedAt: currentIso(),
    };
  }
  const view = updateWorkbenchSessionViewTab(
    toLegacyPanelView(scene),
    surfaceId,
    patch as Partial<Omit<WorkbenchSessionViewTab, "id" | "kind">>,
  );
  return fromLegacyPanelView(scene, view);
}

export function removeWorkbenchSceneSurface(
  scene: WorkbenchSceneSnapshot,
  surfaceId: string,
  options: WorkbenchSceneSurfaceRemoveOptions = {},
): WorkbenchSceneSnapshot {
  if (surfaceId === scene.primary?.id) return scene;
  const view = removeWorkbenchSessionViewTab(toLegacyPanelView(scene), surfaceId, {
    preserveEmptyLeafIds: options.preserveEmptyLeafIds,
    preferredActiveLeafId: options.preferredActiveLeafId,
    preferredActiveTabId: options.preferredActiveSurfaceId,
  });
  return fromLegacyPanelView(scene, view);
}

export function activateWorkbenchSceneSurface(
  scene: WorkbenchSceneSnapshot,
  panelId: WorkbenchPanelId,
  leafId: string,
  surfaceId?: string | null,
): WorkbenchSceneSnapshot {
  return fromLegacyPanelView(
    scene,
    activateWorkbenchSessionViewTab(toLegacyPanelView(scene), panelId, leafId, surfaceId),
  );
}

export function splitWorkbenchSceneLeaf(
  scene: WorkbenchSceneSnapshot,
  input: WorkbenchSceneLeafSplitInput,
): WorkbenchSceneSnapshot {
  if (input.surfaceId === scene.primary?.id) return scene;
  const identityFactory = input.identityFactory ?? defaultIdentityFactory();
  return fromLegacyPanelView(
    scene,
    splitWorkbenchSessionViewLeaf(toLegacyPanelView(scene), {
      panelId: input.panelId,
      leafId: input.leafId,
      side: input.side,
      surfaceId: undefined,
      tabId: input.surfaceId,
      identityFactory: toLegacyIdentityFactory(identityFactory),
    } as Parameters<typeof splitWorkbenchSessionViewLeaf>[1]),
  );
}

export function ensureWorkbenchSceneLeafToRight(
  scene: WorkbenchSceneSnapshot,
  input: WorkbenchSceneLeafInput & {
    readonly identityFactory?: WorkbenchSceneIdentityFactory;
  },
): { readonly scene: WorkbenchSceneSnapshot; readonly leafId: string; readonly created: boolean } {
  const identityFactory = input.identityFactory ?? defaultIdentityFactory();
  const result = ensureWorkbenchSessionViewLeafToRight(toLegacyPanelView(scene), {
    panelId: input.panelId,
    leafId: input.leafId,
    identityFactory: toLegacyIdentityFactory(identityFactory),
  });
  return {
    scene: fromLegacyPanelView(scene, result.view),
    leafId: result.leafId,
    created: result.created,
  };
}

export function mergeWorkbenchSceneLeaf(
  scene: WorkbenchSceneSnapshot,
  input: WorkbenchSceneLeafInput,
): WorkbenchSceneSnapshot {
  const leaf = findWorkbenchPanelLeaf(scene.panels[input.panelId].layout, input.leafId);
  if (scene.primary && leaf?.tabIds.includes(scene.primary.id)) return scene;
  return fromLegacyPanelView(scene, mergeWorkbenchSessionViewLeaf(toLegacyPanelView(scene), input));
}

export function moveWorkbenchSceneSurface(
  scene: WorkbenchSceneSnapshot,
  input: WorkbenchSceneSurfaceMoveInput,
): WorkbenchSceneSnapshot {
  if (input.surfaceId === scene.primary?.id) return scene;
  const identityFactory = input.identityFactory ?? defaultIdentityFactory();
  return fromLegacyPanelView(
    scene,
    moveWorkbenchSessionViewTab(toLegacyPanelView(scene), {
      tabId: input.surfaceId,
      targetPanelId: input.targetPanelId,
      targetLeafId: input.targetLeafId,
      targetIndex: input.targetIndex,
      preserveEmptyLeafIds: input.preserveEmptyLeafIds,
      splitTarget: input.splitTarget,
      identityFactory: toLegacyIdentityFactory(identityFactory),
    }),
  );
}

export function reorderWorkbenchSceneSurfaces(
  scene: WorkbenchSceneSnapshot,
  input: {
    readonly panelId: WorkbenchPanelId;
    readonly leafId: string;
    readonly orderedSurfaceIds: string[];
  },
): WorkbenchSceneSnapshot {
  const leaf = findWorkbenchPanelLeaf(scene.panels[input.panelId].layout, input.leafId);
  const primaryId = scene.primary?.id ?? null;
  const orderedSurfaceIds =
    primaryId && leaf?.tabIds.includes(primaryId)
      ? [primaryId, ...input.orderedSurfaceIds.filter((surfaceId) => surfaceId !== primaryId)]
      : input.orderedSurfaceIds;
  return fromLegacyPanelView(
    scene,
    reorderWorkbenchSessionViewTabs(toLegacyPanelView(scene), {
      panelId: input.panelId,
      leafId: input.leafId,
      orderedTabIds: orderedSurfaceIds,
    }),
  );
}

export function resizeWorkbenchSceneBranch(
  scene: WorkbenchSceneSnapshot,
  input: {
    readonly panelId: WorkbenchPanelId;
    readonly branchId: string;
    readonly ratio: number;
  },
): WorkbenchSceneSnapshot {
  return fromLegacyPanelView(
    scene,
    resizeWorkbenchSessionViewBranch(toLegacyPanelView(scene), input),
  );
}

export function maximizeWorkbenchSceneLeaf(
  scene: WorkbenchSceneSnapshot,
  input: {
    readonly panelId: WorkbenchPanelId;
    readonly leafId: string | null;
  },
): WorkbenchSceneSnapshot {
  return fromLegacyPanelView(
    scene,
    maximizeWorkbenchSessionViewLeaf(toLegacyPanelView(scene), input),
  );
}

export function patchWorkbenchScenePanel(
  scene: WorkbenchSceneSnapshot,
  panelId: WorkbenchPanelId,
  patch: WorkbenchScenePanelPatch,
): WorkbenchSceneSnapshot {
  const adjustedPatch =
    patch.collapsed === true && panelId === "right"
      ? {
          ...patch,
          size: {
            ...patch.size,
            fullWidth: false,
          },
        }
      : patch;
  return fromLegacyPanelView(
    scene,
    patchWorkbenchSessionViewPanel(toLegacyPanelView(scene), panelId, adjustedPatch),
  );
}

function clonePrimarySurface(
  surface: WorkbenchSurfaceDescriptor,
  identityFactory: WorkbenchSceneIdentityFactory,
): WorkbenchSurfaceDescriptor {
  const id = identityFactory.createId("surface");
  if (surface.kind !== "browser") return { ...surface, id };
  return {
    ...surface,
    id,
    config: {
      ...surface.config,
      browserTabId: identityFactory.createId("browser"),
      browserStorageId: identityFactory.createId("browser"),
    },
  };
}

function cloneWorkbenchScene(
  scene: WorkbenchSceneSnapshot,
  identityFactory: WorkbenchSceneIdentityFactory,
): WorkbenchSceneSnapshot {
  const sceneKey = makeWorkbenchSceneKey(scene.owner);
  const legacy = cloneLegacyWorkbenchLayoutForNewWindow(
    {
      sessionViewsBySessionId: {
        [sceneKey]: toLegacyPanelView(scene),
      },
    },
    toLegacyIdentityFactory(identityFactory),
  ).sessionViewsBySessionId[sceneKey];
  if (!legacy) throw new Error(`Missing cloned Workbench Scene ${sceneKey}`);
  const projectId = scene.owner.kind === "project" ? scene.owner.projectId : null;
  const clonedPlacedPrimary = projectId
    ? (Object.values(legacy.tabsById).find((tab) => {
        const surface = tab as WorkbenchSurfaceDescriptor;
        return (
          surface.kind === "db_view" &&
          surface.config.target.kind === "project-default" &&
          surface.config.accessContext.kind === "project" &&
          surface.config.accessContext.projectId === projectId
        );
      }) as WorkbenchSurfaceDescriptor | undefined)
    : undefined;
  return fromLegacyPanelView(
    {
      ...scene,
      primary: scene.primary
        ? (clonedPlacedPrimary ?? clonePrimarySurface(scene.primary, identityFactory))
        : null,
      agentDock: scene.agentDock
        ? {
            ...scene.agentDock,
            newDraftId: identityFactory.createId("draft"),
          }
        : null,
      touchedAt: currentIso(),
    },
    legacy,
  );
}

export function cloneWorkbenchSceneLayoutForNewWindow<Layout extends CloneWorkbenchSceneLayout>(
  layout: Layout,
  identityFactory: WorkbenchSceneIdentityFactory = defaultIdentityFactory(),
): Layout {
  return {
    ...layout,
    scenesByOwnerKey: Object.fromEntries(
      Object.entries(layout.scenesByOwnerKey).map(([sceneKey, scene]) => [
        sceneKey,
        cloneWorkbenchScene(scene, identityFactory),
      ]),
    ),
  };
}

export function getWorkbenchSurfaceReuseKey(surface: WorkbenchSurfaceDescriptor): string | null {
  switch (surface.kind) {
    case "conversation":
      return `conversation:${surface.config.sessionId}`;
    case "db_view": {
      const accessKey = contentAccessContextKey(surface.config.accessContext);
      return surface.config.target.kind === "project-default"
        ? `db:${accessKey}:default`
        : surface.config.target.kind === "database-default"
          ? `db:${accessKey}:database:${surface.config.target.databaseId}:default`
          : `db:${accessKey}:view:${surface.config.target.databaseViewId}`;
    }
    case "page_stage":
      return `page:${contentAccessContextKey(surface.config.accessContext)}:${surface.config.pageId}`;
    case "canvas_stage":
      return `canvas:${contentAccessContextKey(surface.config.accessContext)}:${surface.config.canvasBlockId}`;
    case "review":
      return "review";
    case "files":
      return `files:${surface.config.projectId ?? "projectless"}:${surface.config.path ?? "root"}`;
    case "image_editor":
    case "browser":
    case "terminal":
      return null;
  }
}

export function applyForkBrowserTransferToWorkbenchScene(
  scene: WorkbenchSceneSnapshot,
  snapshot: CodexForkBrowserSidePanelSnapshot,
): WorkbenchSceneSnapshot {
  let next = scene;
  for (const descriptor of snapshot.tabs) {
    const targetLeafId = getWorkbenchPanelActiveLeaf(next.panels[descriptor.panel].layout).id;
    next = createWorkbenchSceneSurface(next, {
      panelId: descriptor.panel,
      targetLeafId,
      surface: {
        id: descriptor.tabId,
        kind: "browser",
        titleSnapshot: "Browser",
        config: {
          browserTabId: descriptor.browserTabId,
          browserStorageId: createSecureRuntimeId("browser"),
          ...(descriptor.initialUrl ? { url: descriptor.initialUrl } : {}),
          deviceToolbarVisible: descriptor.deviceToolbarState.toolbarState.isEnabled,
          deviceToolbarState: descriptor.deviceToolbarState,
        },
        stateKey: 0,
        state: null,
      },
    });
    if (!descriptor.active) continue;
    next = activateWorkbenchSceneSurface(next, descriptor.panel, targetLeafId, descriptor.tabId);
  }

  next = patchWorkbenchScenePanel(next, "right", {
    collapsed: !snapshot.rightPanelOpen,
    size: { fullWidth: snapshot.rightPanelFullWidth },
  });
  next = patchWorkbenchScenePanel(next, "bottom", {
    collapsed: !snapshot.bottomPanelOpen,
  });
  return {
    ...next,
    lastFocusedPanelId:
      snapshot.focusArea === "right-panel"
        ? "right"
        : snapshot.focusArea === "bottom-panel"
          ? "bottom"
          : null,
  };
}
