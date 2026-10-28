import type { PanelId } from "./types";
import { listWorkbenchPanelLeaves } from "../../shared/workbench-panel-layout";
import {
  resolveWorkbenchSceneSurface,
  type WorkbenchSceneSnapshot,
} from "../../shared/workbench-scene";

export interface WorkbenchPanelTabShortcutItem {
  readonly id: string;
  readonly closable?: boolean;
}

export interface WorkbenchPanelTabShortcutGroup {
  readonly itemsByLeafId: Readonly<Record<string, readonly WorkbenchPanelTabShortcutItem[]>>;
  readonly activeTabIdsByLeafId: Readonly<Record<string, string | null>>;
}

export type WorkbenchPanelTabShortcutProjection = Record<PanelId, WorkbenchPanelTabShortcutGroup>;

export interface WorkbenchPanelTabShortcutTarget {
  readonly panelId: PanelId;
  readonly tabId: string;
  readonly leafId: string;
}

export interface WorkbenchPanelTabShortcutState {
  readonly ownerKey: string;
  readonly projection: WorkbenchPanelTabShortcutProjection;
  readonly selectTab: (target: WorkbenchPanelTabShortcutTarget) => void | Promise<void>;
  readonly closeTab: (target: WorkbenchPanelTabShortcutTarget) => void | Promise<void>;
}

export interface WorkbenchPanelTabShortcutFocus {
  readonly ownerKey: string;
  readonly panelId: PanelId;
  readonly leafId: string;
}

export function projectWorkbenchPanelTabShortcutProjection(
  groups: Readonly<{
    readonly [panelId in PanelId]: {
      readonly itemsByLeafId: Readonly<Record<string, readonly WorkbenchPanelTabShortcutItem[]>>;
      readonly activeTabIdsByLeafId: Readonly<Record<string, string | null>>;
    };
  }>,
  options: {
    /**
     * The Chat fills a full view: content tabs stay listed but none is presented, so tab
     * shortcuts never close or cycle a tab the user cannot see.
     */
    readonly rightContentConcealed?: boolean;
  } = {},
): WorkbenchPanelTabShortcutProjection {
  const right = projectPanelTabShortcutGroup(groups.right);
  return {
    right: options.rightContentConcealed
      ? {
          itemsByLeafId: right.itemsByLeafId,
          activeTabIdsByLeafId: Object.fromEntries(
            Object.keys(right.itemsByLeafId).map((leafId) => [leafId, null]),
          ),
        }
      : right,
    bottom: projectPanelTabShortcutGroup(groups.bottom),
  };
}

export function buildWorkbenchScenePanelTabShortcutProjection(
  scene: WorkbenchSceneSnapshot,
): WorkbenchPanelTabShortcutProjection {
  return {
    right: buildScenePanelTabShortcutGroup(scene, "right"),
    bottom: buildScenePanelTabShortcutGroup(scene, "bottom"),
  };
}

function projectPanelTabShortcutGroup(group: {
  readonly itemsByLeafId: Readonly<Record<string, readonly WorkbenchPanelTabShortcutItem[]>>;
  readonly activeTabIdsByLeafId: Readonly<Record<string, string | null>>;
}): WorkbenchPanelTabShortcutGroup {
  return {
    itemsByLeafId: group.itemsByLeafId,
    activeTabIdsByLeafId: group.activeTabIdsByLeafId,
  };
}

function buildScenePanelTabShortcutGroup(
  scene: WorkbenchSceneSnapshot,
  panelId: PanelId,
): WorkbenchPanelTabShortcutGroup {
  const itemsByLeafId: Record<string, readonly WorkbenchPanelTabShortcutItem[]> = {};
  const activeTabIdsByLeafId: Record<string, string | null> = {};

  for (const leaf of listWorkbenchPanelLeaves(scene.panels[panelId].layout)) {
    const items = leaf.tabIds.flatMap((surfaceId) => {
      const surface = resolveWorkbenchSceneSurface(scene, surfaceId);
      if (!surface) return [];
      return [
        {
          id: surface.id,
          closable: surface.id !== scene.primary?.id,
        },
      ];
    });
    itemsByLeafId[leaf.id] = items;
    activeTabIdsByLeafId[leaf.id] = items.some((item) => item.id === leaf.activeTabId)
      ? leaf.activeTabId
      : (items[0]?.id ?? null);
  }

  return {
    itemsByLeafId,
    activeTabIdsByLeafId,
  };
}
