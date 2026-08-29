import type { DragCancelEvent, DragEndEvent, DragMoveEvent, DragOverEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { useCanonicalOrderHandoff } from "@/lib/use-canonical-order-handoff";
import { moveSidebarGroupBefore, resolveSidebarGroupDropTarget } from "./sidebar-project-group-dnd";

const SIDEBAR_SECTION_ROOT_DND_PREFIX = "sidebar-section-root:";

export interface SidebarSectionRootDndController {
  handleDragOver?: (event: DragMoveEvent | DragOverEvent, pointerY: number | null) => void;
  handleDragCancel?: (event?: DragCancelEvent | DragEndEvent) => void;
  handleDragEnd: (event: DragEndEvent, pointerY: number | null) => void;
}

export interface SidebarSectionRootDndPayload {
  readonly kind: "sidebar-section-root";
  readonly controller: SidebarSectionRootDndController;
  readonly dragOverlay: ReactNode;
  readonly sectionId: string;
}

export function getSidebarSectionRootDndId(sectionId: string): string {
  return `${SIDEBAR_SECTION_ROOT_DND_PREFIX}${sectionId}`;
}

export function parseSidebarSectionRootDndId(value: string): string | null {
  if (!value.startsWith(SIDEBAR_SECTION_ROOT_DND_PREFIX)) return null;
  return value.slice(SIDEBAR_SECTION_ROOT_DND_PREFIX.length).trim() || null;
}

export function readSidebarSectionRootDndPayload(
  value: unknown,
): SidebarSectionRootDndPayload | null {
  if (!value || typeof value !== "object") return null;
  return Reflect.get(value, "kind") === "sidebar-section-root"
    ? (value as SidebarSectionRootDndPayload)
    : null;
}

export function SidebarSectionRootSortableContext({
  sectionIds,
  children,
}: {
  readonly sectionIds: readonly string[];
  readonly children: ReactNode;
}) {
  return (
    <SortableContext
      items={sectionIds.map(getSidebarSectionRootDndId)}
      strategy={verticalListSortingStrategy}
    >
      {children}
    </SortableContext>
  );
}

export function useSidebarSectionRootReorderController({
  sectionIds,
  reorderSections,
}: {
  readonly sectionIds: readonly string[];
  readonly reorderSections: (sectionIds: readonly string[]) => Promise<void> | void;
}) {
  const [dropTarget, setDropTarget] = useState<{ beforeGroupId: string | null } | null>(null);
  const orderHandoff = useCanonicalOrderHandoff({
    canonicalIds: sectionIds,
    reportError: (error) => console.error("Sidebar Section reorder failed", error),
  });
  const displayedSectionIds = useMemo(
    () => [...orderHandoff.displayedIds],
    [orderHandoff.displayedIds],
  );
  const resolveDropTarget = useCallback(
    (event: DragOverEvent | DragEndEvent, pointerY: number | null) =>
      resolveSidebarGroupDropTarget({
        groupIds: displayedSectionIds,
        activeGroupId: parseSidebarSectionRootDndId(String(event.active.id)),
        overGroupId: event.over ? parseSidebarSectionRootDndId(String(event.over.id)) : null,
        activeRect: event.active.rect.current.translated,
        overRect: event.over?.rect ?? null,
        pointerY,
      }),
    [displayedSectionIds],
  );
  const controller = useMemo<SidebarSectionRootDndController>(
    () => ({
      handleDragOver(event, pointerY) {
        setDropTarget(resolveDropTarget(event, pointerY));
      },
      handleDragCancel() {
        setDropTarget(null);
      },
      handleDragEnd(event, pointerY) {
        const sectionId = parseSidebarSectionRootDndId(String(event.active.id));
        const target = resolveDropTarget(event, pointerY);
        setDropTarget(null);
        if (!sectionId || !target) return;
        const nextIds = moveSidebarGroupBefore(
          displayedSectionIds,
          sectionId,
          target.beforeGroupId,
        );
        orderHandoff.submit(nextIds, () => reorderSections(nextIds));
      },
    }),
    [displayedSectionIds, orderHandoff, reorderSections, resolveDropTarget],
  );
  const dropIndicatorIndex =
    dropTarget === null
      ? null
      : dropTarget.beforeGroupId === null
        ? displayedSectionIds.length
        : displayedSectionIds.indexOf(dropTarget.beforeGroupId);

  return { controller, dropIndicatorIndex, sectionIds: displayedSectionIds };
}
