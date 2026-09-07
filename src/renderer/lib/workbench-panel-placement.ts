import {
  findNearestWorkbenchPanelLeafToRight,
  findWorkbenchPanelLeaf,
  findWorkbenchPanelLeafForTab,
  getWorkbenchPanelActiveLeaf,
  listWorkbenchPanelLeaves,
  type WorkbenchPanelLayout,
} from "../../shared/workbench-panel-layout";
import type { PanelId, WorkbenchTabProjection } from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";

export type RightNeighborPanelPlacement =
  | { readonly kind: "fallback" }
  | { readonly kind: "existing"; readonly leafId: string }
  | { readonly kind: "ensure"; readonly sourceLeafId: string };

export type WorkbenchSurfaceRelativePlacement =
  | {
      readonly kind: "same-group";
      readonly sourceSurfaceId: string;
    }
  | {
      readonly kind: "adjacent-right";
      readonly sourceSurfaceId: string;
    };

export type WorkbenchSessionPanelSurfaceTarget =
  | { readonly kind: "fallback"; readonly panelId: PanelId }
  | { readonly kind: "existing"; readonly panelId: PanelId; readonly leafId: string }
  | { readonly kind: "ensure-right"; readonly sourceLeafId: string };

export interface WorkbenchPanelSurfaceSlot {
  readonly panelId: PanelId;
  readonly leafId: string;
}

export function resolveRightNeighborPanelPlacement(
  layout: WorkbenchPanelLayout,
  sourceLeafId: string | null,
  options: {
    readonly fullWidth: boolean;
  },
): RightNeighborPanelPlacement {
  if (!sourceLeafId) return { kind: "fallback" };
  if (!findWorkbenchPanelLeaf(layout, sourceLeafId)) {
    return { kind: "fallback" };
  }

  const existingLeafId = findNearestWorkbenchPanelLeafToRight(layout, sourceLeafId);
  if (existingLeafId) return { kind: "existing", leafId: existingLeafId };
  if (!options.fullWidth) {
    return { kind: "fallback" };
  }
  if (listWorkbenchPanelLeaves(layout).length !== 1) {
    return { kind: "fallback" };
  }
  return { kind: "ensure", sourceLeafId };
}

export function resolveSessionPanelActiveTabId(
  session: WorkbenchSessionRenderProjection,
  panelId: PanelId,
): string | null {
  const panel = session.panels[panelId];
  return (
    getWorkbenchPanelActiveLeaf(panel.layout).activeTabId ??
    session.tabs.find((tab) => tab.panelId === panelId)?.id ??
    null
  );
}

export function resolveSessionPanelActiveLeafId(
  session: Pick<WorkbenchSessionRenderProjection, "panels">,
  panelId: PanelId,
): string {
  return getWorkbenchPanelActiveLeaf(session.panels[panelId].layout).id;
}

export function resolveLeafIdForPanelTab(
  session: WorkbenchSessionRenderProjection,
  panelId: PanelId,
  tabId: string,
): string {
  return (
    findWorkbenchPanelLeafForTab(session.panels[panelId].layout, tabId)?.id ??
    resolveSessionPanelActiveLeafId(session, panelId)
  );
}

export function resolveSessionPanelSurfaceTarget(
  session: WorkbenchSessionRenderProjection,
  requestedPanelId: PanelId,
  placement: WorkbenchSurfaceRelativePlacement | undefined,
  options: {
    readonly rightPanelFullWidth: boolean;
    readonly sourceSlot?: WorkbenchPanelSurfaceSlot | null;
  },
): WorkbenchSessionPanelSurfaceTarget {
  if (!placement) return { kind: "fallback", panelId: requestedPanelId };

  const sourceTab = session.tabs.find((tab) => tab.id === placement.sourceSurfaceId);
  const durableSourceLeaf = sourceTab
    ? findWorkbenchPanelLeafForTab(session.panels[sourceTab.panelId].layout, sourceTab.id)
    : null;
  const durableSourceSlot =
    sourceTab && durableSourceLeaf
      ? { panelId: sourceTab.panelId, leafId: durableSourceLeaf.id }
      : null;
  const sourceSlot = durableSourceSlot ?? options.sourceSlot;
  if (!sourceSlot) return { kind: "fallback", panelId: requestedPanelId };

  if (placement.kind === "same-group" || sourceSlot.panelId === "bottom") {
    return { kind: "existing", ...sourceSlot };
  }

  const adjacent = resolveRightNeighborPanelPlacement(
    session.panels.right.layout,
    sourceSlot.leafId,
    { fullWidth: options.rightPanelFullWidth },
  );
  if (adjacent.kind === "existing") {
    return { kind: "existing", panelId: "right", leafId: adjacent.leafId };
  }
  if (adjacent.kind === "ensure") {
    return { kind: "ensure-right", sourceLeafId: adjacent.sourceLeafId };
  }
  return { kind: "existing", panelId: "right", leafId: sourceSlot.leafId };
}

export function readPageStagePanelTabPageRef(
  tab: WorkbenchTabProjection | null | undefined,
): { projectId: string; pageId: string } | null {
  if (!tab || tab.kind !== "page_stage") return null;
  if (tab.config.accessContext.kind !== "project") return null;

  return {
    projectId: tab.config.accessContext.projectId,
    pageId: tab.config.pageId,
  };
}

export function readCanvasStagePanelTabCanvasRef(
  tab: WorkbenchTabProjection | null | undefined,
): { projectId: string; canvasBlockId: string } | null {
  if (!tab || tab.kind !== "canvas_stage") return null;
  if (tab.config.accessContext.kind !== "project") return null;

  return {
    projectId: tab.config.accessContext.projectId,
    canvasBlockId: tab.config.canvasBlockId,
  };
}
