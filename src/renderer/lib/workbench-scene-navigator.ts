import { resolveBrowserTabTitle } from "../../shared/browser-url";
import {
  canonicalWorkbenchFilesConfig,
  workbenchFileResourceId,
} from "../../shared/workbench-resource-identity";
import { findWorkbenchPanelLeafForTab } from "../../shared/workbench-panel-layout";
import {
  activateWorkbenchSceneSurface,
  createWorkbenchSceneSurface,
  ensureWorkbenchSceneLeafToRight,
  getWorkbenchSurfaceReuseKey,
  materializeInitialWorkbenchScene,
  patchWorkbenchScenePanel,
  resolveWorkbenchSceneSurface,
  type WorkbenchBrowserSurfaceConfig,
  type WorkbenchCanvasStageSurfaceConfig,
  type WorkbenchDbViewSurfaceConfig,
  type WorkbenchFilesSurfaceConfig,
  type WorkbenchPageStageSurfaceConfig,
  type WorkbenchReviewSurfaceConfig,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
  type WorkbenchTerminalSurfaceConfig,
} from "../../shared/workbench-scene";
import type { WorkbenchSceneLocation } from "../../shared/workbench-layout";
import type { WorkbenchPanelId } from "../../shared/workbench-session-view";
import { createSecureRuntimeId } from "../../shared/secure-runtime-id";
import type { WorkbenchSurfaceReveal } from "../../shared/nodex-app-tools/workbench-reveal";
import { updateWorkbenchSceneSurface } from "../../shared/workbench-scene";
import {
  resolveRightNeighborPanelPlacement,
  type WorkbenchSurfaceRelativePlacement,
} from "./workbench-panel-placement";

export type WorkbenchSurfaceOpenRequest =
  | {
      readonly kind: "conversation";
      readonly sessionId: string;
      readonly titleSnapshot?: string;
    }
  | {
      readonly kind: "db_view";
      readonly config: WorkbenchDbViewSurfaceConfig;
      readonly titleSnapshot?: string;
    }
  | {
      readonly kind: "page_stage";
      readonly config: WorkbenchPageStageSurfaceConfig;
      readonly titleSnapshot?: string;
    }
  | {
      readonly kind: "canvas_stage";
      readonly config: WorkbenchCanvasStageSurfaceConfig;
      readonly titleSnapshot?: string;
    }
  | {
      readonly kind: "terminal";
      readonly config: Omit<WorkbenchTerminalSurfaceConfig, "terminalSessionId"> & {
        readonly terminalSessionId?: string;
      };
      readonly titleSnapshot?: string;
    }
  | {
      readonly kind: "browser";
      readonly config?: Omit<WorkbenchBrowserSurfaceConfig, "browserTabId" | "browserStorageId"> & {
        readonly browserTabId?: string;
        readonly browserStorageId?: string;
      };
      readonly titleSnapshot?: string;
    }
  | {
      readonly kind: "review";
      readonly config: WorkbenchReviewSurfaceConfig;
      readonly titleSnapshot?: string;
    }
  | {
      readonly kind: "files";
      readonly config: WorkbenchFilesSurfaceConfig;
      readonly titleSnapshot?: string;
      readonly reveal?: Extract<WorkbenchSurfaceReveal, { kind: "file" }>;
      /** Files tab state the file opens with, such as showing its changes. */
      readonly openState?: object | null;
    };

export interface PresentWorkbenchPanelSurfaceInput {
  readonly owner: WorkbenchSceneOwner;
  readonly request: WorkbenchSurfaceOpenRequest;
  readonly target: {
    readonly panelId: WorkbenchPanelId;
    readonly leafId?: string;
    readonly placement?: WorkbenchSurfaceRelativePlacement;
  };
  readonly mode: "durable" | "preview";
  readonly navigation: "select-owner" | "background";
  readonly isCurrent?: () => boolean;
}

export function resolvePanelSurfaceTarget(
  scene: WorkbenchSceneSnapshot,
  target: PresentWorkbenchPanelSurfaceInput["target"],
  previewEntries: readonly WorkbenchScenePreviewEntry[],
): {
  readonly scene: WorkbenchSceneSnapshot;
  readonly panelId: WorkbenchPanelId;
  readonly leafId: string | undefined;
} {
  if (!target.placement) {
    return { scene, panelId: target.panelId, leafId: target.leafId };
  }
  const sourceSurface = resolveWorkbenchSceneSurface(scene, target.placement.sourceSurfaceId);
  const durableSourcePanelId = sourceSurface
    ? (["right", "bottom"] as const).find((panelId) =>
        findWorkbenchPanelLeafForTab(scene.panels[panelId].layout, sourceSurface.id),
      )
    : undefined;
  const durableSourceLeaf =
    sourceSurface && durableSourcePanelId
      ? findWorkbenchPanelLeafForTab(scene.panels[durableSourcePanelId].layout, sourceSurface.id)
      : null;
  const previewSource = previewEntries.find(
    (entry) => entry.surface.id === target.placement?.sourceSurfaceId,
  );
  const sourcePanelId = durableSourcePanelId ?? previewSource?.panelId;
  const sourceLeafId = durableSourceLeaf?.id ?? previewSource?.leafId;
  if (!sourcePanelId || !sourceLeafId) {
    return { scene, panelId: target.panelId, leafId: target.leafId };
  }
  if (target.placement.kind === "same-group") {
    return { scene, panelId: sourcePanelId, leafId: sourceLeafId };
  }
  if (sourcePanelId === "bottom") {
    return { scene, panelId: "bottom", leafId: sourceLeafId };
  }

  const placement = resolveRightNeighborPanelPlacement(scene.panels.right.layout, sourceLeafId, {
    fullWidth: scene.panels.right.size.fullWidth ?? false,
  });
  if (placement.kind === "fallback") {
    return { scene, panelId: "right", leafId: sourceLeafId };
  }
  if (placement.kind === "existing") {
    return { scene, panelId: "right", leafId: placement.leafId };
  }

  const ensured = ensureWorkbenchSceneLeafToRight(scene, {
    panelId: "right",
    leafId: placement.sourceLeafId,
  });
  return { scene: ensured.scene, panelId: "right", leafId: ensured.leafId };
}

export type PresentWorkbenchPanelSurfaceResult =
  | {
      readonly status: "presented";
      readonly surfaceId: string;
      readonly reused: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
    };

export interface WorkbenchSceneNavigatorIdentityFactory {
  createId(kind: "surface" | "browser" | "terminal"): string;
}

export interface WorkbenchSceneNavigatorPort {
  readonly getScene: (owner: WorkbenchSceneOwner) => WorkbenchSceneSnapshot | undefined;
  readonly presentDurable: (
    input: PresentWorkbenchPanelSurfaceInput,
    surface: WorkbenchSurfaceDescriptor,
  ) => Promise<PresentWorkbenchPanelSurfaceResult>;
  /** Runtime-bound and native Sessions both have a conversation; unstarted drafts do not. */
  readonly hasConversation: (sessionId: string) => boolean;
  readonly setScene: (
    owner: WorkbenchSceneOwner,
    update: (previous: WorkbenchSceneSnapshot | undefined) => WorkbenchSceneSnapshot,
  ) => void;
  readonly selectLocation: (location: WorkbenchSceneLocation) => void;
  readonly setSceneAndSelect: (
    owner: WorkbenchSceneOwner,
    update: (previous: WorkbenchSceneSnapshot | undefined) => WorkbenchSceneSnapshot,
    location: WorkbenchSceneLocation,
  ) => void;
  readonly preview?: {
    readonly prepareReplace?: (
      owner: WorkbenchSceneOwner,
      entry: WorkbenchScenePreviewEntry,
    ) => Promise<boolean>;
    readonly list: (owner: WorkbenchSceneOwner) => readonly WorkbenchScenePreviewEntry[];
    readonly set: (
      owner: WorkbenchSceneOwner,
      panelId: WorkbenchPanelId,
      leafId: string,
      surface: WorkbenchSurfaceDescriptor | null,
    ) => void;
  };
}

export interface WorkbenchScenePreviewEntry {
  readonly panelId: WorkbenchPanelId;
  readonly leafId: string;
  readonly surface: WorkbenchSurfaceDescriptor;
}

export interface WorkbenchSceneNavigator {
  readonly openProject: (projectId: string) => void;
  readonly openSession: (session: {
    readonly id: string;
    readonly projectId: string | null;
  }) => void;
  readonly openLibrary: () => void;
  readonly presentPanelSurface: (
    input: PresentWorkbenchPanelSurfaceInput,
  ) => Promise<PresentWorkbenchPanelSurfaceResult>;
  readonly clearPreview: (input: {
    readonly owner: WorkbenchSceneOwner;
    readonly panelId: WorkbenchPanelId;
    readonly leafId: string;
    readonly surfaceId?: string;
  }) => boolean;
  readonly pinPreview: (input: {
    readonly owner: WorkbenchSceneOwner;
    readonly panelId: WorkbenchPanelId;
    readonly leafId: string;
    readonly surfaceId: string;
  }) => boolean;
}

function createDefaultIdentityFactory(): WorkbenchSceneNavigatorIdentityFactory {
  return {
    createId(kind) {
      return createSecureRuntimeId(kind);
    },
  };
}

function applyFileReveal(
  surface: WorkbenchSurfaceDescriptor,
  reveal: Extract<WorkbenchSurfaceReveal, { kind: "file" }> | undefined,
  openState?: object | null,
): WorkbenchSurfaceDescriptor {
  if ((!reveal && !openState) || surface.kind !== "files") return surface;
  const previous =
    surface.state && typeof surface.state === "object" && !Array.isArray(surface.state)
      ? surface.state
      : {};
  const location = reveal ? (({ kind: _kind, ...rest }) => rest)(reveal) : null;
  return {
    ...surface,
    stateKey: surface.stateKey + 1,
    state: { ...previous, ...openState, ...(location ? { pendingReveal: location } : {}) },
  };
}

function makeSurfaceDescriptor(
  request: WorkbenchSurfaceOpenRequest,
  identities: WorkbenchSceneNavigatorIdentityFactory,
): WorkbenchSurfaceDescriptor {
  const common = {
    id:
      request.kind === "files" && request.config.path
        ? workbenchFileResourceId(
            request.config.hostId,
            request.config.path,
            request.config.cwd ?? request.config.workspaceRoot,
          )
        : identities.createId("surface"),
    stateKey: 0,
    state: null,
  } as const;

  switch (request.kind) {
    case "conversation":
      return {
        ...common,
        kind: request.kind,
        titleSnapshot: request.titleSnapshot ?? "New chat",
        config: { sessionId: request.sessionId },
      };
    case "db_view":
      return {
        ...common,
        kind: request.kind,
        titleSnapshot: request.titleSnapshot ?? "Database",
        config: request.config,
      };
    case "page_stage":
      return {
        ...common,
        kind: request.kind,
        titleSnapshot: request.titleSnapshot ?? "Page",
        config: request.config,
      };
    case "canvas_stage":
      return {
        ...common,
        kind: request.kind,
        titleSnapshot: request.titleSnapshot ?? "Canvas",
        config: request.config,
      };
    case "terminal":
      return {
        ...common,
        kind: request.kind,
        titleSnapshot: request.titleSnapshot ?? "Terminal",
        config: {
          ...request.config,
          terminalSessionId: request.config.terminalSessionId ?? identities.createId("terminal"),
        },
      };
    case "browser": {
      const browserTabId = request.config?.browserTabId ?? identities.createId("browser");
      return {
        ...common,
        kind: request.kind,
        titleSnapshot:
          request.titleSnapshot ?? resolveBrowserTabTitle(request.config?.url, undefined),
        config: {
          ...request.config,
          browserTabId,
          browserStorageId: request.config?.browserStorageId ?? `browser:scene:${browserTabId}`,
        },
      };
    }
    case "review":
      return {
        ...common,
        kind: request.kind,
        titleSnapshot: request.titleSnapshot ?? "Review",
        config: request.config,
      };
    case "files":
      return applyFileReveal(
        {
          ...common,
          kind: request.kind,
          titleSnapshot:
            request.titleSnapshot ?? request.config.path?.split(/[\\/]/).pop() ?? "Files",
          config: canonicalWorkbenchFilesConfig(request.config),
        },
        request.reveal,
        request.openState,
      );
  }
}

function matchingPreviewEntry(
  port: WorkbenchSceneNavigatorPort,
  owner: WorkbenchSceneOwner,
  candidate: WorkbenchSurfaceDescriptor,
): WorkbenchScenePreviewEntry | null {
  const reuseKey = getWorkbenchSurfaceReuseKey(candidate);
  if (!reuseKey) return null;
  return (
    port.preview
      ?.list(owner)
      .find((entry) => getWorkbenchSurfaceReuseKey(entry.surface) === reuseKey) ?? null
  );
}

function updateSceneForNavigation(
  port: WorkbenchSceneNavigatorPort,
  owner: WorkbenchSceneOwner,
  navigation: PresentWorkbenchPanelSurfaceInput["navigation"],
  update: (stored: WorkbenchSceneSnapshot | undefined) => WorkbenchSceneSnapshot,
): void {
  if (navigation === "select-owner") {
    port.setSceneAndSelect(owner, update, sceneLocationForOwner(owner));
    return;
  }
  port.setScene(owner, update);
}

async function presentPreviewSurface(
  port: WorkbenchSceneNavigatorPort,
  input: PresentWorkbenchPanelSurfaceInput,
  candidate: WorkbenchSurfaceDescriptor,
): Promise<PresentWorkbenchPanelSurfaceResult> {
  if (!port.preview) {
    return {
      status: "unavailable",
      reason: "Preview presentation is unavailable for this Scene",
    };
  }

  const initialScene = port.getScene(input.owner) ?? materializeInitialWorkbenchScene(input.owner);
  const entries = port.preview.list(input.owner);
  const reuseKey = getWorkbenchSurfaceReuseKey(candidate);
  const matchingDurable = Object.values(initialScene.panelSurfacesById).find(
    (surface) => getWorkbenchSurfaceReuseKey(surface) === reuseKey,
  );
  const matchingPreview = matchingPreviewEntry(port, input.owner, candidate);
  const durableTarget =
    matchingDurable &&
    (["right", "bottom"] as const).flatMap((panelId) => {
      const leaf = findWorkbenchPanelLeafForTab(
        initialScene.panels[panelId].layout,
        matchingDurable.id,
      );
      return leaf ? [{ panelId, leafId: leaf.id }] : [];
    })[0];
  const target =
    durableTarget ||
    matchingPreview ||
    resolvePanelSurfaceTarget(initialScene, input.target, entries);
  const targetLeaf = target.leafId ?? initialScene.panels[target.panelId].layout.activeLeafId;
  const replacing = entries.find(
    (entry) =>
      entry.panelId === target.panelId &&
      entry.leafId === targetLeaf &&
      entry.surface.id !== candidate.id,
  );
  if (replacing && port.preview.prepareReplace) {
    if (!(await port.preview.prepareReplace(input.owner, replacing)))
      return { status: "unavailable", reason: "Save pending changes before opening another file" };
    const current = port.preview
      .list(input.owner)
      .find((entry) => entry.panelId === replacing.panelId && entry.leafId === replacing.leafId);
    if (
      current?.surface.id !== replacing.surface.id ||
      current.surface.stateKey !== replacing.surface.stateKey
    )
      return { status: "unavailable", reason: "The preview changed while this file was opening" };
  }
  if (input.isCurrent?.() === false)
    return { status: "unavailable", reason: "The Scene changed while this file was opening" };
  const reveal = input.request.kind === "files" ? input.request.reveal : undefined;
  const openState = input.request.kind === "files" ? input.request.openState : undefined;
  let result: PresentWorkbenchPanelSurfaceResult = {
    status: "presented",
    surfaceId: matchingPreview?.surface.id ?? candidate.id,
    reused: matchingPreview !== null,
  };
  let previewEntry: WorkbenchScenePreviewEntry | null = matchingPreview
    ? {
        ...matchingPreview,
        surface: applyFileReveal(
          {
            ...candidate,
            id: matchingPreview.surface.id,
            stateKey: matchingPreview.surface.stateKey,
            state: matchingPreview.surface.state,
          },
          reveal,
          openState,
        ),
      }
    : null;
  let durableSlot: {
    readonly panelId: WorkbenchPanelId;
    readonly leafId: string;
  } | null = null;

  updateSceneForNavigation(port, input.owner, input.navigation, (stored) => {
    const scene = stored ?? materializeInitialWorkbenchScene(input.owner);
    const reuseKey = getWorkbenchSurfaceReuseKey(candidate);
    const durable =
      reuseKey === null
        ? null
        : (Object.values(scene.panelSurfacesById).find(
            (surface) => getWorkbenchSurfaceReuseKey(surface) === reuseKey,
          ) ?? null);
    if (durable) {
      for (const panelId of ["right", "bottom"] as const) {
        const leaf = findWorkbenchPanelLeafForTab(scene.panels[panelId].layout, durable.id);
        if (!leaf) continue;
        result = {
          status: "presented",
          surfaceId: durable.id,
          reused: true,
        };
        durableSlot = { panelId, leafId: leaf.id };
        previewEntry = null;
        const revealed = applyFileReveal(durable, reveal, openState);
        const revealedScene =
          revealed === durable
            ? scene
            : updateWorkbenchSceneSurface(scene, durable.id, {
                state: revealed.state,
                stateKey: revealed.stateKey,
              });
        return patchWorkbenchScenePanel(
          activateWorkbenchSceneSurface(revealedScene, panelId, leaf.id, durable.id),
          panelId,
          { collapsed: false },
        );
      }
    }

    if (matchingPreview && previewEntry) {
      return patchWorkbenchScenePanel(
        activateWorkbenchSceneSurface(scene, matchingPreview.panelId, matchingPreview.leafId),
        matchingPreview.panelId,
        { collapsed: false },
      );
    }

    const target = resolvePanelSurfaceTarget(
      scene,
      input.target,
      port.preview?.list(input.owner) ?? [],
    );
    previewEntry = {
      panelId: target.panelId,
      leafId: target.leafId ?? target.scene.panels[target.panelId].layout.activeLeafId,
      surface: candidate,
    };
    return patchWorkbenchScenePanel(
      activateWorkbenchSceneSurface(target.scene, previewEntry.panelId, previewEntry.leafId),
      previewEntry.panelId,
      { collapsed: false },
    );
  });

  const settledDurableSlot = durableSlot as {
    readonly panelId: WorkbenchPanelId;
    readonly leafId: string;
  } | null;
  if (settledDurableSlot) {
    port.preview.set(input.owner, settledDurableSlot.panelId, settledDurableSlot.leafId, null);
    return result;
  }
  if (previewEntry) {
    port.preview.set(input.owner, previewEntry.panelId, previewEntry.leafId, previewEntry.surface);
  }
  return result;
}

function validateSceneSurfaceRequest(
  port: WorkbenchSceneNavigatorPort,
  input: PresentWorkbenchPanelSurfaceInput,
): PresentWorkbenchPanelSurfaceResult | null {
  if (input.request.kind === "conversation") {
    return {
      status: "unavailable",
      reason: "Conversation is the Session Scene primary, not a panel surface",
    };
  }
  if (input.owner.kind === "project" && input.request.kind === "review") {
    return {
      status: "unavailable",
      reason: "Review requires an attached Session",
    };
  }
  if (
    input.owner.kind === "session" &&
    input.request.kind === "review" &&
    !port.hasConversation(input.owner.sessionId)
  ) {
    return {
      status: "unavailable",
      reason: "Review requires a started conversation",
    };
  }
  if (input.owner.kind !== "library" && input.owner.kind !== "inbox") return null;
  if (
    input.request.kind === "files" &&
    input.request.config.projectId === null &&
    (input.request.config.path || input.request.config.workspaceRoot)
  )
    return null;

  const requestAllowed =
    input.request.kind === "page_stage" ||
    input.request.kind === "canvas_stage" ||
    input.request.kind === "db_view";
  const libraryAuthorized =
    requestAllowed &&
    input.request.config.routingContext.kind === "library" &&
    (input.request.kind !== "db_view" || input.request.config.target.kind !== "project-default");
  return libraryAuthorized
    ? null
    : {
        status: "unavailable",
        reason: "This surface requires a Project or chat",
      };
}

export function createWorkbenchSceneNavigator(
  port: WorkbenchSceneNavigatorPort,
  identities: WorkbenchSceneNavigatorIdentityFactory = createDefaultIdentityFactory(),
): WorkbenchSceneNavigator {
  const presentPanelSurface = async (
    input: PresentWorkbenchPanelSurfaceInput,
  ): Promise<PresentWorkbenchPanelSurfaceResult> => {
    if (input.isCurrent?.() === false)
      return { status: "unavailable", reason: "The Scene changed while this file was opening" };
    const unavailable = validateSceneSurfaceRequest(port, input);
    if (unavailable) return unavailable;

    const candidate = makeSurfaceDescriptor(input.request, identities);
    if (input.mode === "preview") {
      return presentPreviewSurface(port, input, candidate);
    }
    return port.presentDurable(input, candidate);
  };

  const clearPreview = (input: {
    readonly owner: WorkbenchSceneOwner;
    readonly panelId: WorkbenchPanelId;
    readonly leafId: string;
    readonly surfaceId?: string;
  }): boolean => {
    const entry = port.preview
      ?.list(input.owner)
      .find(
        (candidate) => candidate.panelId === input.panelId && candidate.leafId === input.leafId,
      );
    if (!entry) return false;
    if (input.surfaceId && entry.surface.id !== input.surfaceId) return false;
    port.preview?.set(input.owner, input.panelId, input.leafId, null);
    return true;
  };

  const pinPreview = (
    input: {
      readonly owner: WorkbenchSceneOwner;
      readonly panelId: WorkbenchPanelId;
      readonly leafId: string;
      readonly surfaceId: string;
    },
    navigation: PresentWorkbenchPanelSurfaceInput["navigation"] = "background",
  ): boolean => {
    const entry = port.preview
      ?.list(input.owner)
      .find(
        (candidate) =>
          candidate.panelId === input.panelId &&
          candidate.leafId === input.leafId &&
          candidate.surface.id === input.surfaceId,
      );
    if (!entry) return false;

    updateSceneForNavigation(port, input.owner, navigation, (stored) => {
      const scene = stored ?? materializeInitialWorkbenchScene(input.owner);
      return patchWorkbenchScenePanel(
        createWorkbenchSceneSurface(scene, {
          panelId: input.panelId,
          targetLeafId: input.leafId,
          surface: entry.surface,
        }),
        input.panelId,
        { collapsed: false },
      );
    });
    port.preview?.set(input.owner, input.panelId, input.leafId, null);
    return true;
  };

  return {
    openProject(projectId) {
      port.selectLocation({ kind: "project", projectId });
    },
    openSession(session) {
      port.selectLocation({
        kind: "session",
        sessionId: session.id,
        projectContextId: session.projectId,
      });
    },
    openLibrary() {
      port.selectLocation({ kind: "library" });
    },
    presentPanelSurface,
    clearPreview,
    pinPreview,
  };
}

export function sceneLocationForOwner(owner: WorkbenchSceneOwner): WorkbenchSceneLocation {
  if (owner.kind === "project") {
    return { kind: "project", projectId: owner.projectId };
  }
  if (owner.kind === "session") {
    return {
      kind: "session",
      sessionId: owner.sessionId,
      projectContextId: null,
    };
  }
  return { kind: owner.kind };
}
