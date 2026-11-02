import type { ResolvedLinkOpenRequest } from "../../../shared/link-opening";
import {
  getWorkbenchSceneReturnLocation,
  type WorkbenchLocation,
} from "../../../shared/workbench-layout";
import { findWorkbenchPanelLeafForTab } from "../../../shared/workbench-panel-layout";
import {
  activateWorkbenchSceneSurface,
  patchWorkbenchScenePanel,
  moveWorkbenchSceneSurface,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../../shared/workbench-scene";
import type { WorkbenchSceneNavigator } from "@/lib/workbench-scene-navigator";

export function linkBrowserOwner(location: WorkbenchLocation): WorkbenchSceneOwner | null {
  const scene = getWorkbenchSceneReturnLocation(location);
  if (scene.kind === "project") return { kind: "project", projectId: scene.projectId };
  if (scene.kind === "session") return { kind: "session", sessionId: scene.sessionId };
  return null;
}
function normalizedUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}
export function findMatchingLinkBrowserTab(input: {
  readonly scene: WorkbenchSceneSnapshot;
  readonly url: string;
  readonly tabs: readonly {
    readonly browserTabId: string;
    readonly url: string;
    readonly pendingUrl?: string;
  }[];
  readonly agentActiveTabId?: string;
}): Extract<WorkbenchSurfaceDescriptor, { kind: "browser" }> | undefined {
  const url = normalizedUrl(input.url);
  const matches = Object.values(input.scene.panelSurfacesById).filter(
    (surface): surface is Extract<WorkbenchSurfaceDescriptor, { kind: "browser" }> => {
      if (surface.kind !== "browser") return false;
      const runtime = input.tabs.find((tab) => tab.browserTabId === surface.config.browserTabId);
      return (
        normalizedUrl(runtime?.url ?? surface.config.url) === url ||
        (runtime?.pendingUrl !== undefined && normalizedUrl(runtime.pendingUrl) === url)
      );
    },
  );
  return (
    matches.find((tab) => tab.config.browserTabId === input.agentActiveTabId) ?? matches.at(-1)
  );
}
/** Browser-origin requests follow their opener's current panel group in the captured Scene. */
export function createWorkbenchLinkPresenter(port: {
  readonly getOwner: () => WorkbenchSceneOwner | null;
  readonly getScene: (owner: WorkbenchSceneOwner) => WorkbenchSceneSnapshot;
  readonly updateScene: (
    owner: WorkbenchSceneOwner,
    update: (scene: WorkbenchSceneSnapshot) => WorkbenchSceneSnapshot,
  ) => void;
  readonly getBrowserState: (owner: WorkbenchSceneOwner) => {
    readonly tabs: readonly {
      readonly browserTabId: string;
      readonly url: string;
      readonly pendingUrl?: string;
    }[];
    readonly agentActiveTabId?: string;
  };
  readonly navigator: WorkbenchSceneNavigator;
  readonly openWindow: (url: string) => Promise<boolean>;
}) {
  return async (
    request: ResolvedLinkOpenRequest,
    openerBrowserTabId?: string,
  ): Promise<boolean> => {
    const owner = port.getOwner();
    if (!owner || (owner.kind !== "project" && owner.kind !== "session")) return false;
    const scene = port.getScene(owner);
    const opener = openerBrowserTabId
      ? Object.values(scene.panelSurfacesById).find(
          (surface) =>
            surface.kind === "browser" && surface.config.browserTabId === openerBrowserTabId,
        )
      : undefined;
    const openerPanelId = opener
      ? (["right", "bottom"] as const).find((panelId) =>
          findWorkbenchPanelLeafForTab(scene.panels[panelId].layout, opener.id),
        )
      : undefined;
    if (openerBrowserTabId && !openerPanelId) return false;
    if (request.presentationIntent === "new-window") return await port.openWindow(request.url);
    const matching =
      !opener && request.disposition === "default"
        ? findMatchingLinkBrowserTab({ scene, url: request.url, ...port.getBrowserState(owner) })
        : undefined;
    if (matching) {
      port.updateScene(owner, (current) => {
        const panelId = (["right", "bottom"] as const).find((panel) =>
          findWorkbenchPanelLeafForTab(current.panels[panel].layout, matching.id),
        );
        if (!panelId) return current;
        const presentationPanel = request.presentationIntent ? "right" : panelId;
        const placed =
          presentationPanel === panelId
            ? current
            : moveWorkbenchSceneSurface(current, {
                surfaceId: matching.id,
                targetPanelId: presentationPanel,
              });
        const leaf = findWorkbenchPanelLeafForTab(
          placed.panels[presentationPanel].layout,
          matching.id,
        );
        if (!leaf) return current;
        return patchWorkbenchScenePanel(
          activateWorkbenchSceneSurface(placed, presentationPanel, leaf.id, matching.id),
          presentationPanel,
          {
            collapsed: false,
            ...(request.presentationIntent
              ? {
                  size: {
                    ...placed.panels[presentationPanel].size,
                    fullWidth: request.presentationIntent === "full-width",
                  },
                }
              : {}),
          },
        );
      });
      return true;
    }
    const result = await port.navigator.presentPanelSurface({
      owner,
      request: { kind: "browser", config: { url: request.url } },
      target: {
        panelId: openerPanelId ?? "right",
        ...(opener
          ? {
              placement: { kind: "same-group" as const, sourceSurfaceId: opener.id },
              afterSource: true,
            }
          : {}),
      },
      mode: "durable",
      navigation: "background",
      tab: request.disposition === "new-background-tab" ? "background" : "activate",
    });
    if (result.status !== "presented") return false;
    port.updateScene(owner, (current) =>
      patchWorkbenchScenePanel(current, openerPanelId ?? "right", {
        collapsed: false,
        ...(request.presentationIntent
          ? {
              size: {
                ...current.panels.right.size,
                fullWidth: request.presentationIntent === "full-width",
              },
            }
          : {}),
      }),
    );
    return true;
  };
}
