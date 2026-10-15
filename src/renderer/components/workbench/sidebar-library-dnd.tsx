import { useDraggable, useDroppable, type Data } from "@dnd-kit/core";
import { useCallback, type ReactNode } from "react";

import type { LibraryPlacementAnchor, LibraryWriteParent } from "../../../shared/library-module";
import type { LibraryResourceTarget } from "../library/library-resource-actions";

export interface SidebarLibraryDragResource {
  readonly kind: "sidebar-library-resource";
  readonly target: LibraryResourceTarget;
  readonly title: string;
  readonly expectedLocationRevision: number;
  readonly dragOverlay: ReactNode;
}

export interface SidebarLibraryOwnershipDropTarget {
  readonly kind: "sidebar-library-ownership-target";
  readonly parent: LibraryWriteParent;
  readonly nestParent?: LibraryWriteParent;
}

export type SidebarLibraryDropDecision =
  | {
      readonly kind: "move";
      readonly resource: SidebarLibraryDragResource;
      readonly parent: LibraryWriteParent;
    }
  | { readonly kind: "reject" };

export const readSidebarLibraryDragResource = (
  data: Data | undefined,
): SidebarLibraryDragResource | null => {
  if (data?.kind !== "sidebar-library-resource") return null;
  if (!data.target || typeof data.title !== "string") return null;
  if (!Number.isInteger(data.expectedLocationRevision)) return null;
  return data as unknown as SidebarLibraryDragResource;
};

export const readSidebarLibraryOwnershipDropTarget = (
  data: Data | undefined,
): SidebarLibraryOwnershipDropTarget | null => {
  if (data?.kind !== "sidebar-library-ownership-target") return null;
  if (!data.parent) return null;
  return data as unknown as SidebarLibraryOwnershipDropTarget;
};

export const resolveSidebarLibraryDropDecision = (
  activeData: Data | undefined,
  overData: Data | undefined,
  preferNest = false,
): SidebarLibraryDropDecision => {
  const resource = readSidebarLibraryDragResource(activeData);
  if (!resource) return { kind: "reject" };
  const ownership = readSidebarLibraryOwnershipDropTarget(overData);
  if (ownership) {
    const parent = preferNest && ownership.nestParent ? ownership.nestParent : ownership.parent;
    if (
      resource.target.kind === "page" &&
      parent.kind === "page" &&
      parent.pageId === resource.target.pageId
    ) {
      return { kind: "reject" };
    }
    return { kind: "move", resource, parent };
  }
  return { kind: "reject" };
};

const resourceKey = (target: LibraryResourceTarget): string =>
  target.kind === "page" ? `page:${target.pageId}` : `database:${target.databaseId}`;

export const useSidebarLibraryResourceDnd = (
  input: Readonly<{
    resource: Omit<SidebarLibraryDragResource, "kind"> | null;
    disabledKey: string;
    ownerParent: LibraryWriteParent;
    nestParent?: LibraryWriteParent;
    before?: LibraryPlacementAnchor;
  }>,
) => {
  const key = input.resource ? resourceKey(input.resource.target) : `disabled:${input.disabledKey}`;
  const draggable = useDraggable({
    id: `sidebar-library-resource:${key}`,
    disabled: input.resource === null,
    data: input.resource
      ? { kind: "sidebar-library-resource", ...input.resource }
      : { kind: "sidebar-library-disabled" },
  });
  const dropParent = {
    ...input.ownerParent,
    ...(input.before ? { before: input.before } : {}),
  };
  const droppable = useDroppable({
    id: `sidebar-library-target:${key}`,
    disabled: input.resource === null,
    data: {
      kind: "sidebar-library-ownership-target",
      parent: dropParent,
      ...(input.nestParent ? { nestParent: input.nestParent } : {}),
    },
  });
  const setDraggableNodeRef = draggable.setNodeRef;
  const setDroppableNodeRef = droppable.setNodeRef;
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDraggableNodeRef(node);
      setDroppableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );

  return {
    attributes: draggable.attributes,
    listeners: draggable.listeners,
    isDragging: draggable.isDragging,
    isOver: droppable.isOver,
    setNodeRef,
  };
};

export const useSidebarLibraryRootDropTarget = () =>
  useDroppable({
    id: "sidebar-library-target:root",
    data: {
      kind: "sidebar-library-ownership-target",
      parent: { kind: "library" },
    },
  });
