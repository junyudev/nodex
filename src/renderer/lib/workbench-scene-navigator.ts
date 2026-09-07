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
  readonly presentDurable: (
    input: PresentWorkbenchPanelSurfaceInput,
    surface: WorkbenchSurfaceDescriptor,
  ) => Promise<PresentWorkbenchPanelSurfaceResult>;
  readonly hasAttachedThread: (sessionId: string) => boolean;
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
  readonly openPages: () => void;
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

function makeSurfaceDescriptor(
  request: WorkbenchSurfaceOpenRequest,
  identities: WorkbenchSceneNavigatorIdentityFactory,
): WorkbenchSurfaceDescriptor {
  const common = {
    id: identities.createId("surface"),
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
        titleSnapshot: request.titleSnapshot ?? "Browser",
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
      return {
        ...common,
        kind: request.kind,
        titleSnapshot:
          request.titleSnapshot ?? request.config.path?.split(/[\\/]/).pop() ?? "Files",
        config: request.config,
      };
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

function presentPreviewSurface(
  port: WorkbenchSceneNavigatorPort,
  input: PresentWorkbenchPanelSurfaceInput,
  candidate: WorkbenchSurfaceDescriptor,
): PresentWorkbenchPanelSurfaceResult {
  if (!port.preview) {
    return {
      status: "unavailable",
      reason: "Preview presentation is unavailable for this Scene",
    };
  }

  const matchingPreview = matchingPreviewEntry(port, input.owner, candidate);
  let result: PresentWorkbenchPanelSurfaceResult = {
    status: "presented",
    surfaceId: matchingPreview?.surface.id ?? candidate.id,
    reused: matchingPreview !== null,
  };
  let previewEntry: WorkbenchScenePreviewEntry | null = matchingPreview
    ? {
        ...matchingPreview,
        surface: {
          ...candidate,
          id: matchingPreview.surface.id,
          stateKey: matchingPreview.surface.stateKey,
          state: matchingPreview.surface.state,
        },
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
        return patchWorkbenchScenePanel(
          activateWorkbenchSceneSurface(scene, panelId, leaf.id, durable.id),
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
    !port.hasAttachedThread(input.owner.sessionId)
  ) {
    return {
      status: "unavailable",
      reason: "Review requires an attached Thread",
    };
  }
  if (input.owner.kind !== "pages") return null;

  const requestAllowed =
    input.request.kind === "page_stage" ||
    input.request.kind === "canvas_stage" ||
    input.request.kind === "db_view";
  const libraryAuthorized =
    requestAllowed &&
    input.request.config.accessContext.kind === "library" &&
    (input.request.kind !== "db_view" || input.request.config.target.kind !== "project-default");
  return libraryAuthorized
    ? null
    : {
        status: "unavailable",
        reason: "Pages only accepts Library content surfaces",
      };
}

export function createWorkbenchSceneNavigator(
  port: WorkbenchSceneNavigatorPort,
  identities: WorkbenchSceneNavigatorIdentityFactory = createDefaultIdentityFactory(),
): WorkbenchSceneNavigator {
  const presentPanelSurface = async (
    input: PresentWorkbenchPanelSurfaceInput,
  ): Promise<PresentWorkbenchPanelSurfaceResult> => {
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
    openPages() {
      port.selectLocation({ kind: "pages" });
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
  return { kind: "pages" };
}
