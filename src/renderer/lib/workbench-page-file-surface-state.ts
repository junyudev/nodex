import type {
  WorkbenchPageFileSurfaceConfig,
  WorkbenchSceneOwner,
} from "../../shared/workbench-scene";
import { makeWorkbenchSceneKey, updateWorkbenchSceneSurface } from "../../shared/workbench-scene";
import {
  listWorkbenchScenePreviewEntries,
  makeWorkbenchScenePreviewSlotKey,
} from "./workbench-scene-preview";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";

export type WorkbenchPageFileConfigPatch = Partial<
  Pick<WorkbenchPageFileSurfaceConfig, "fileId" | "logicalPath" | "titleSnapshot">
>;

/** A rename or path replacement follows the same descriptor through preview promotion and restoration. */
export function updateWorkbenchPageFileConfig(
  owner: WorkbenchWindowOwner,
  sceneOwner: WorkbenchSceneOwner,
  surfaceId: string,
  patch: WorkbenchPageFileConfigPatch,
): void {
  const state = owner.read();
  const scene = state.windowState.scenesByOwnerKey[makeWorkbenchSceneKey(sceneOwner)];
  if (scene?.panelSurfacesById[surfaceId]?.kind === "page_file") {
    owner.setScene(sceneOwner, (current) => {
      if (!current) return scene;
      const surface = current.panelSurfacesById[surfaceId];
      if (surface?.kind !== "page_file") return current;
      return updateWorkbenchSceneSurface(current, surfaceId, {
        config: { ...surface.config, ...patch },
        ...(patch.titleSnapshot === undefined ? {} : { titleSnapshot: patch.titleSnapshot }),
      });
    });
    return;
  }
  if (sceneOwner.kind === "session") {
    owner.dispatchEphemeral({
      type: "update",
      field: "previewTabsByPanel",
      update: (current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, tab]) => [
            key,
            tab.id === surfaceId &&
            tab.sessionId === sceneOwner.sessionId &&
            tab.kind === "page_file"
              ? {
                  ...tab,
                  config: { ...tab.config, ...patch },
                  ...(patch.titleSnapshot === undefined ? {} : { title: patch.titleSnapshot }),
                }
              : tab,
          ]),
        ),
    });
    return;
  }
  if (!scene) return;
  const entry = listWorkbenchScenePreviewEntries(
    scene,
    state.ephemeralPanels.previewSurfacesByPanel,
  ).find((entry) => entry.surface.id === surfaceId);
  if (!entry) return;
  const slotKey = makeWorkbenchScenePreviewSlotKey(sceneOwner, entry.panelId, entry.leafId);
  owner.dispatchEphemeral({
    type: "update",
    field: "previewSurfacesByPanel",
    update: (current) =>
      Object.fromEntries(
        Object.entries(current).map(([key, surface]) => [
          key,
          key === slotKey && surface.id === surfaceId && surface.kind === "page_file"
            ? {
                ...surface,
                config: { ...surface.config, ...patch },
                ...(patch.titleSnapshot === undefined
                  ? {}
                  : { titleSnapshot: patch.titleSnapshot }),
              }
            : surface,
        ]),
      ),
  });
}
