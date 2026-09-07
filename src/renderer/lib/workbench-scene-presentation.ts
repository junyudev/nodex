import { listWorkbenchPanelLeaves } from "../../shared/workbench-panel-layout";
import { createSecureRuntimeId } from "../../shared/secure-runtime-id";
import type {
  PanelId,
  ProjectSession,
  WorkbenchPanelState,
  WorkbenchTabCreateInput,
  WorkbenchTabProjection,
  WorkbenchTabUpdateInput,
} from "../../shared/types";
import type {
  WorkbenchSceneSnapshot,
  WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import type {
  WorkbenchSessionPanelProjection,
  WorkbenchSessionRenderProjection,
} from "./workbench-session-presentation";

export type WorkbenchSurfaceUpdatePatch = WorkbenchTabUpdateInput;

function makeRuntimeId(prefix: string): string {
  return createSecureRuntimeId(prefix);
}

function resourceProjectId(
  session: Pick<WorkbenchSessionPanelProjection, "projectId">,
  surface: WorkbenchSurfaceDescriptor,
): string | null {
  if (
    surface.kind === "db_view" ||
    surface.kind === "page_stage" ||
    surface.kind === "canvas_stage"
  ) {
    return surface.config.accessContext.kind === "project"
      ? surface.config.accessContext.projectId
      : null;
  }
  return "projectId" in surface.config ? surface.config.projectId : (session.projectId ?? null);
}

function projectionConfig(
  surface: Exclude<WorkbenchSurfaceDescriptor, { readonly kind: "conversation" }>,
): WorkbenchTabProjection["config"] {
  if (surface.kind !== "browser") return surface.config;
  return {
    projectId: null,
    ...(surface.config.browserUseSource
      ? { browserUseSource: surface.config.browserUseSource }
      : {}),
    ...(surface.config.browserStorageId
      ? { browserStorageId: surface.config.browserStorageId }
      : {}),
    ...(surface.config.url ? { url: surface.config.url } : {}),
    ...(surface.config.title ? { title: surface.config.title } : {}),
    ...(surface.config.faviconUrl ? { faviconUrl: surface.config.faviconUrl } : {}),
    ...(surface.config.deviceToolbarVisible === undefined
      ? {}
      : { deviceToolbarVisible: surface.config.deviceToolbarVisible }),
    ...(surface.config.deviceToolbarState === undefined
      ? {}
      : { deviceToolbarState: surface.config.deviceToolbarState }),
  };
}

export function presentWorkbenchSessionDomainWithScene(
  session: ProjectSession,
  scene: WorkbenchSceneSnapshot,
): WorkbenchSessionRenderProjection {
  return { ...session, ...presentWorkbenchSessionPanelsWithScene(session, scene) };
}

/** Project only existing Scene panel identities; no Session domain record is synthesized. */
export function presentWorkbenchSessionPanelsWithScene(
  session: Pick<WorkbenchSessionPanelProjection, "id" | "projectId">,
  scene: WorkbenchSceneSnapshot,
): WorkbenchSessionPanelProjection {
  if (scene.owner.kind !== "session" || scene.owner.sessionId !== session.id) {
    throw new Error(`Scene does not belong to Session ${session.id}`);
  }
  const timestamp = scene.touchedAt;
  const tabs = (["right", "bottom"] as const).flatMap((panelId) =>
    listWorkbenchPanelLeaves(scene.panels[panelId].layout)
      .flatMap((leaf) => leaf.tabIds)
      .map((surfaceId, order) => {
        const surface = scene.panelSurfacesById[surfaceId];
        if (!surface || surface.kind === "conversation") return null;
        const base = {
          id: surface.id,
          sessionId: session.id,
          projectId: resourceProjectId(session, surface),
          panelId,
          title: surface.titleSnapshot,
          order,
          stateKey: surface.stateKey,
          state: surface.state,
          createdAt: timestamp,
          updatedAt: timestamp,
          kind: surface.kind,
          config: projectionConfig(surface),
        };
        return surface.kind === "browser"
          ? { ...base, browserTabId: surface.config.browserTabId }
          : { ...base, browserTabId: null };
      })
      .filter((tab): tab is WorkbenchTabProjection => Boolean(tab)),
  );
  return {
    id: session.id,
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
    panels: scene.panels as Record<PanelId, WorkbenchPanelState>,
    tabs,
  };
}

export function workbenchSurfaceFromCreateInput(
  input: WorkbenchTabCreateInput,
): WorkbenchSurfaceDescriptor {
  const id = input.clientTabId ?? makeRuntimeId("surface");
  const common = {
    id,
    titleSnapshot: input.title,
    stateKey: 0,
    state: null,
  };
  if (input.kind === "browser") {
    return {
      ...common,
      kind: "browser",
      config: {
        browserTabId: input.browserTabId ?? makeRuntimeId("browser"),
        ...("browserUseSource" in input.config && input.config.browserUseSource
          ? { browserUseSource: input.config.browserUseSource }
          : {}),
        browserStorageId:
          ("browserStorageId" in input.config && input.config.browserStorageId) ||
          makeRuntimeId("browser"),
        ...(input.config.url ? { url: input.config.url } : {}),
        ...(input.config.title ? { title: input.config.title } : {}),
        ...(input.config.faviconUrl ? { faviconUrl: input.config.faviconUrl } : {}),
        ...(input.config.deviceToolbarVisible === undefined
          ? {}
          : { deviceToolbarVisible: input.config.deviceToolbarVisible }),
        ...("deviceToolbarState" in input.config && input.config.deviceToolbarState !== undefined
          ? { deviceToolbarState: input.config.deviceToolbarState }
          : {}),
      },
    };
  }
  return {
    ...common,
    kind: input.kind,
    config: input.config,
  } as WorkbenchSurfaceDescriptor;
}

export function applyWorkbenchSurfacePatch(
  surface: WorkbenchSurfaceDescriptor,
  patch: WorkbenchSurfaceUpdatePatch,
): WorkbenchSurfaceDescriptor {
  const common = {
    ...surface,
    ...(patch.title === undefined ? {} : { titleSnapshot: patch.title }),
    ...(patch.stateKey === undefined ? {} : { stateKey: patch.stateKey }),
    ...(!("state" in patch) ? {} : { state: patch.state }),
  };
  if (patch.config === undefined) return common;
  if (surface.kind === "browser") {
    const config = patch.config;
    return {
      ...common,
      kind: "browser",
      config: {
        browserTabId: surface.config.browserTabId,
        ...("browserUseSource" in config && config.browserUseSource
          ? { browserUseSource: config.browserUseSource }
          : surface.config.browserUseSource
            ? { browserUseSource: surface.config.browserUseSource }
            : {}),
        browserStorageId:
          ("browserStorageId" in config && config.browserStorageId) ||
          surface.config.browserStorageId ||
          makeRuntimeId("browser"),
        ...("url" in config && config.url ? { url: config.url } : {}),
        ...("title" in config && config.title ? { title: config.title } : {}),
        ...("faviconUrl" in config && config.faviconUrl ? { faviconUrl: config.faviconUrl } : {}),
        ...("deviceToolbarVisible" in config && config.deviceToolbarVisible !== undefined
          ? { deviceToolbarVisible: config.deviceToolbarVisible }
          : {}),
        ...("deviceToolbarState" in config && config.deviceToolbarState !== undefined
          ? { deviceToolbarState: config.deviceToolbarState }
          : {}),
      },
    };
  }
  if (surface.kind === "db_view") {
    if (!("target" in patch.config)) {
      return common;
    }
    return {
      ...common,
      kind: "db_view",
      config: patch.config,
    };
  }
  if (surface.kind === "page_stage" && "pageId" in patch.config) {
    return {
      ...common,
      kind: "page_stage",
      config: patch.config,
    };
  }
  if (surface.kind === "canvas_stage" && "canvasBlockId" in patch.config) {
    return {
      ...common,
      kind: "canvas_stage",
      config: patch.config,
    };
  }
  return {
    ...common,
    config: patch.config,
  } as WorkbenchSurfaceDescriptor;
}
