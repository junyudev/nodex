import {
  activateWorkbenchPanelLeaf,
  findWorkbenchPanelLeaf,
  insertWorkbenchPanelTabInBackground,
  listWorkbenchPanelLeaves,
  reorderWorkbenchPanelLeafTabs,
} from "../../shared/workbench-panel-layout";
import { orderWorkbenchPanelTabs } from "./workbench-panel-order";
import {
  makeWorkbenchSceneKey,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import type { PanelId } from "./types";
import { makeWorkbenchPanelSlotKey } from "./workbench-panel-slot-key";
import type { WorkbenchScenePreviewEntry } from "./workbench-scene-navigator";

export function makeWorkbenchScenePreviewSlotKey(
  owner: WorkbenchSceneOwner,
  panelId: PanelId,
  leafId: string,
): string {
  return makeWorkbenchPanelSlotKey(makeWorkbenchSceneKey(owner), panelId, leafId);
}

export function listWorkbenchScenePreviewEntries(
  scene: WorkbenchSceneSnapshot,
  previewSurfacesByPanel: Readonly<Record<string, WorkbenchSurfaceDescriptor>>,
  tabOrderByPanelGroup: Readonly<Record<string, readonly string[]>> = {},
): WorkbenchScenePreviewEntry[] {
  const entries: WorkbenchScenePreviewEntry[] = [];
  for (const panelId of ["right", "bottom"] as const) {
    for (const leaf of listWorkbenchPanelLeaves(scene.panels[panelId].layout)) {
      const surface =
        previewSurfacesByPanel[makeWorkbenchScenePreviewSlotKey(scene.owner, panelId, leaf.id)];
      if (!surface || scene.panelSurfacesById[surface.id]) continue;
      const index = tabOrderByPanelGroup[
        makeWorkbenchScenePreviewSlotKey(scene.owner, panelId, leaf.id)
      ]?.indexOf(surface.id);
      entries.push({
        panelId,
        leafId: leaf.id,
        surface,
        ...(index !== undefined && index >= 0 ? { targetIndex: index } : {}),
      });
    }
  }
  return entries;
}

/**
 * Builds the renderer-only Scene projection consumed by tab chrome, presence,
 * and breadcrumbs. Preview descriptors never enter the persisted Scene.
 */
export function projectWorkbenchScenePreviews(
  scene: WorkbenchSceneSnapshot,
  previewSurfacesByPanel: Readonly<Record<string, WorkbenchSurfaceDescriptor>>,
  tabOrderByPanelGroup: Readonly<Record<string, readonly string[]>> = {},
): {
  readonly scene: WorkbenchSceneSnapshot;
  readonly previewSurfaceIds: ReadonlySet<string>;
} {
  const entries = listWorkbenchScenePreviewEntries(
    scene,
    previewSurfacesByPanel,
    tabOrderByPanelGroup,
  );
  if (entries.length === 0 && Object.keys(tabOrderByPanelGroup).length === 0) {
    return { scene, previewSurfaceIds: new Set() };
  }

  const panels = { ...scene.panels };
  const panelSurfacesById = { ...scene.panelSurfacesById };
  const previewSurfaceIds = new Set<string>();

  for (const panelId of ["right", "bottom"] as const) {
    const panelEntries = entries.filter((entry) => entry.panelId === panelId);
    const durableLayout = scene.panels[panelId].layout;
    let layout = durableLayout;
    for (const entry of panelEntries) {
      layout = insertWorkbenchPanelTabInBackground(layout, {
        tabId: entry.surface.id,
        targetLeafId: entry.leafId,
        targetIndex: entry.targetIndex,
      });
      layout = activateWorkbenchPanelLeaf(layout, entry.leafId, entry.surface.id);
      panelSurfacesById[entry.surface.id] = entry.surface;
      previewSurfaceIds.add(entry.surface.id);
    }
    for (const leaf of listWorkbenchPanelLeaves(layout)) {
      const order =
        tabOrderByPanelGroup[makeWorkbenchScenePreviewSlotKey(scene.owner, panelId, leaf.id)];
      if (!order) continue;
      const orderedIds = orderWorkbenchPanelTabs(
        leaf.tabIds.map((id) => ({ id })),
        order,
      ).map((tab) => tab.id);
      layout = reorderWorkbenchPanelLeafTabs(layout, leaf.id, orderedIds);
    }
    panels[panelId] = {
      ...scene.panels[panelId],
      layout: {
        ...layout,
        activeLeafId: durableLayout.activeLeafId,
        mruLeafIds: durableLayout.mruLeafIds,
        maximizedLeafId: durableLayout.maximizedLeafId,
      },
    };
  }

  return {
    scene: {
      ...scene,
      panels,
      panelSurfacesById,
    },
    previewSurfaceIds,
  };
}

/** Install a preview at a requested position while retaining the group's authored mixed order. */
export function orderWorkbenchScenePreview(
  scene: WorkbenchSceneSnapshot,
  panelId: PanelId,
  leafId: string,
  surfaceId: string,
  targetIndex: number,
  current: Record<string, readonly string[]>,
): Record<string, readonly string[]> {
  const key = makeWorkbenchScenePreviewSlotKey(scene.owner, panelId, leafId);
  const leaf = findWorkbenchPanelLeaf(scene.panels[panelId].layout, leafId);
  const ids = orderWorkbenchPanelTabs(
    (leaf?.tabIds ?? []).map((id) => ({ id })),
    current[key],
  )
    .map((tab) => tab.id)
    .filter((id) => id !== surfaceId);
  ids.splice(targetIndex, 0, surfaceId);
  return { ...current, [key]: ids };
}
