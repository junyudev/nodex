import {
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useCanonicalOrderHandoff } from "@/lib/use-canonical-order-handoff";

export const SIDEBAR_GROUP_DND_PREFIX = "sidebar-group:";
export const PINNED_PROJECT_CONTAINER_ID = "pinned";

export interface SidebarGroupDndController {
  handleDragStart?: (event: DragStartEvent) => void;
  handleDragOver?: (event: DragMoveEvent | DragOverEvent, pointerY: number | null) => void;
  handleDragCancel?: (event?: DragCancelEvent | DragEndEvent) => void;
  handleDragEnd: (event: DragEndEvent, pointerY: number | null) => void;
}

export interface SidebarGroupDndPayload {
  kind: "sidebar-group";
  controller: SidebarGroupDndController;
  containerId?: string;
  dragOverlay: ReactNode;
  itemId?: string;
  itemIds?: string[];
  nextItemId?: string | null;
  projectId: string;
}

interface SidebarProjectDndContextValue {
  activeProjectId: string | null;
  projectDragActive: boolean;
  reportError: (error: unknown) => void;
}

const DEFAULT_REPORT_ERROR = (error: unknown): void => {
  console.error("Sidebar project reorder failed", error);
};

const SidebarProjectDndContext = createContext<SidebarProjectDndContextValue>({
  activeProjectId: null,
  projectDragActive: false,
  reportError: DEFAULT_REPORT_ERROR,
});

interface SidebarDropRect {
  bottom: number;
  top: number;
}

export interface SidebarGroupDropTarget {
  beforeGroupId: string | null;
}

export function getSidebarGroupDndId(projectId: string): string {
  return `${SIDEBAR_GROUP_DND_PREFIX}${projectId}`;
}

export function parseSidebarGroupDndId(id: string): string | null {
  if (!id.startsWith(SIDEBAR_GROUP_DND_PREFIX)) return null;
  const projectId = id.slice(SIDEBAR_GROUP_DND_PREFIX.length);
  return projectId.length > 0 ? projectId : null;
}

export function readSidebarGroupDndPayload(value: unknown): SidebarGroupDndPayload | null {
  if (!value || typeof value !== "object") return null;
  return Reflect.get(value, "kind") === "sidebar-group" ? (value as SidebarGroupDndPayload) : null;
}

function sameStringOrder(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

export function moveSidebarGroupBefore(
  groupIds: readonly string[],
  activeGroupId: string,
  beforeGroupId: string | null,
): string[] {
  if (!groupIds.includes(activeGroupId)) return [...groupIds];

  const remainingGroupIds = groupIds.filter((groupId) => groupId !== activeGroupId);
  const insertionIndex =
    beforeGroupId === null ? remainingGroupIds.length : remainingGroupIds.indexOf(beforeGroupId);
  if (insertionIndex < 0) return [...groupIds];

  return [
    ...remainingGroupIds.slice(0, insertionIndex),
    activeGroupId,
    ...remainingGroupIds.slice(insertionIndex),
  ];
}

export function resolveSidebarGroupDropTarget({
  groupIds,
  activeGroupId,
  overGroupId,
  activeRect,
  overRect,
  pointerY,
}: {
  groupIds: readonly string[];
  activeGroupId: string | null;
  overGroupId: string | null;
  activeRect: SidebarDropRect | null;
  overRect: SidebarDropRect | null;
  pointerY: number | null;
}): SidebarGroupDropTarget | null {
  if (!activeGroupId || !overGroupId) return null;
  if (activeGroupId === overGroupId) return null;
  if (!activeRect || !overRect) return null;

  const remainingGroupIds = groupIds.filter((groupId) => groupId !== activeGroupId);
  const overIndex = remainingGroupIds.indexOf(overGroupId);
  if (overIndex < 0) return null;

  const activeMidpoint = (activeRect.top + activeRect.bottom) / 2;
  const overMidpoint = (overRect.top + overRect.bottom) / 2;
  const placement = (pointerY ?? activeMidpoint) < overMidpoint ? "before" : "after";
  const beforeGroupId = remainingGroupIds[overIndex + (placement === "after" ? 1 : 0)] ?? null;
  const nextGroupIds = moveSidebarGroupBefore(groupIds, activeGroupId, beforeGroupId);
  if (sameStringOrder(groupIds, nextGroupIds)) return null;

  return { beforeGroupId };
}

export function SidebarProjectDndStateProvider({
  activeProjectId,
  children,
  onError = DEFAULT_REPORT_ERROR,
}: {
  activeProjectId: string | null;
  children: ReactNode;
  onError?: (error: unknown) => void;
}) {
  const contextValue = useMemo(
    () => ({
      activeProjectId,
      projectDragActive: activeProjectId !== null,
      reportError: onError,
    }),
    [activeProjectId, onError],
  );

  return (
    <SidebarProjectDndContext.Provider value={contextValue}>
      {children}
    </SidebarProjectDndContext.Provider>
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  if (leftSet.size !== left.length) return false;
  const rightSet = new Set(right);
  if (rightSet.size !== right.length) return false;
  for (const item of leftSet) {
    if (!rightSet.has(item)) return false;
  }
  return true;
}

export function useSidebarGroupReorderController({
  groupIds,
  reorderGroups,
}: {
  groupIds: string[];
  reorderGroups: (nextGroupIds: string[]) => void | Promise<void>;
}): {
  controller: SidebarGroupDndController;
  dropIndicatorIndex: number | null;
  groupIds: string[];
} {
  const { reportError } = useContext(SidebarProjectDndContext);
  const [dropTarget, setDropTarget] = useState<SidebarGroupDropTarget | null>(null);
  const orderHandoff = useCanonicalOrderHandoff({
    canonicalIds: groupIds,
    reportError,
  });
  const displayedGroupIds = useMemo(
    () => [...orderHandoff.displayedIds],
    [orderHandoff.displayedIds],
  );

  const resolveDropTarget = useCallback(
    (event: DragOverEvent | DragEndEvent, pointerY: number | null) =>
      resolveSidebarGroupDropTarget({
        groupIds: displayedGroupIds,
        activeGroupId: parseSidebarGroupDndId(String(event.active.id)),
        overGroupId: event.over ? parseSidebarGroupDndId(String(event.over.id)) : null,
        activeRect: event.active.rect.current.translated,
        overRect: event.over?.rect ?? null,
        pointerY,
      }),
    [displayedGroupIds],
  );

  const controller = useMemo<SidebarGroupDndController>(
    () => ({
      handleDragOver(event, pointerY) {
        setDropTarget(resolveDropTarget(event, pointerY));
      },
      handleDragCancel() {
        setDropTarget(null);
      },
      handleDragEnd(event, pointerY) {
        const activeId = parseSidebarGroupDndId(String(event.active.id));
        const target = resolveDropTarget(event, pointerY);
        setDropTarget(null);
        if (!activeId || !target) {
          return;
        }

        const nextGroupIds = moveSidebarGroupBefore(
          displayedGroupIds,
          activeId,
          target.beforeGroupId,
        );
        orderHandoff.submit(nextGroupIds, () => reorderGroups(nextGroupIds));
      },
    }),
    [displayedGroupIds, orderHandoff, reorderGroups, resolveDropTarget],
  );

  const dropIndicatorIndex =
    dropTarget === null
      ? null
      : dropTarget.beforeGroupId === null
        ? displayedGroupIds.length
        : displayedGroupIds.indexOf(dropTarget.beforeGroupId);

  return {
    controller,
    dropIndicatorIndex,
    groupIds: displayedGroupIds,
  };
}

export function useSidebarProjectDndState(): SidebarProjectDndContextValue {
  return useContext(SidebarProjectDndContext);
}

export function SidebarProjectSortableContext({
  groupIds,
  children,
}: {
  groupIds: string[];
  children: ReactNode;
}) {
  return (
    <SortableContext
      items={groupIds.map(getSidebarGroupDndId)}
      strategy={verticalListSortingStrategy}
    >
      {children}
    </SortableContext>
  );
}

export function replaceVisibleOrder(
  currentIds: readonly string[],
  visibleIds: readonly string[],
  nextVisibleIds: readonly string[],
): string[] {
  if (!sameStringSet(visibleIds, nextVisibleIds)) return [...currentIds];
  const visibleIdSet = new Set(visibleIds);
  let nextIndex = 0;
  return currentIds.map((projectId) => {
    if (!visibleIdSet.has(projectId)) return projectId;
    const nextProjectId = nextVisibleIds[nextIndex];
    nextIndex += 1;
    return nextProjectId ?? projectId;
  });
}
