import type {
  SidebarSectionItem,
  SidebarSectionItemPlacement,
  SidebarSectionItemRef,
} from "../../../shared/sidebar-sections";

export function sidebarSectionItemRef(item: SidebarSectionItem): SidebarSectionItemRef {
  return item.kind === "project"
    ? { kind: "project", projectId: item.project.projectId }
    : { kind: "session", sessionId: item.session.id };
}

export function isSidebarSectionSessionDragDisabled({
  placementId,
  threadId,
}: {
  placementId?: string;
  threadId: string | null;
}): boolean {
  return threadId === null && placementId === undefined;
}

export function resolveSidebarSectionItemPlacement(
  items: readonly SidebarSectionItem[],
  beforePlacementId: string | null | undefined,
): SidebarSectionItemPlacement {
  if (beforePlacementId === null || beforePlacementId === undefined) return { kind: "end" };
  const beforeItem = items.find((item) => item.placementId === beforePlacementId);
  return beforeItem ? { kind: "before", item: sidebarSectionItemRef(beforeItem) } : { kind: "end" };
}
