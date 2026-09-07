import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import {
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  normalizeWorkbenchScene,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../../../shared/workbench-scene";

function surfaceFromProjection(
  tab: WorkbenchSessionRenderProjection["tabs"][number],
): WorkbenchSurfaceDescriptor {
  const common = {
    id: tab.id,
    titleSnapshot: tab.title,
    stateKey: tab.stateKey,
    state: tab.state,
  };
  if (tab.kind === "browser") {
    return {
      ...common,
      kind: "browser",
      config: {
        browserTabId: tab.browserTabId,
        ...("browserStorageId" in tab.config && tab.config.browserStorageId
          ? { browserStorageId: tab.config.browserStorageId }
          : {}),
        ...(tab.config.url ? { url: tab.config.url } : {}),
        ...(tab.config.title ? { title: tab.config.title } : {}),
        ...(tab.config.faviconUrl ? { faviconUrl: tab.config.faviconUrl } : {}),
        ...(tab.config.deviceToolbarVisible === undefined
          ? {}
          : { deviceToolbarVisible: tab.config.deviceToolbarVisible }),
        ...("deviceToolbarState" in tab.config && tab.config.deviceToolbarState !== undefined
          ? { deviceToolbarState: tab.config.deviceToolbarState }
          : {}),
      },
    };
  }
  return {
    ...common,
    kind: tab.kind,
    config: tab.config,
  } as WorkbenchSurfaceDescriptor;
}

export function makeSessionSceneFixture(
  session: WorkbenchSessionRenderProjection,
): WorkbenchSceneSnapshot {
  const owner = { kind: "session", sessionId: session.id } as const;
  const initial = materializeInitialWorkbenchScene(owner, {
    touchedAt: session.updatedAt,
    identityFactory: {
      createId: (kind) => `fixture:${makeWorkbenchSceneKey(owner)}:${kind}`,
    },
  });
  return normalizeWorkbenchScene({
    ...initial,
    panelSurfacesById: Object.fromEntries(
      session.tabs.map((tab) => [tab.id, surfaceFromProjection(tab)]),
    ),
    panels: session.panels,
    touchedAt: session.updatedAt,
  });
}
