import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { CardStatus } from "@/lib/types";
import {
  buildKanbanColumnDropTargetData,
  type KanbanCardDragData,
} from "./pragmatic-drag-data";

export interface BindKanbanColumnDropSurfaceInput {
  columnId: CardStatus;
  columnDropDisabled: boolean;
  dragInstanceId?: symbol;
  element: HTMLElement | null;
  scrollElement: HTMLElement | null;
}

interface ColumnDropSurfaceDeps {
  autoScrollForElements: typeof autoScrollForElements;
  combine: typeof combine;
  dropTargetForElements: typeof dropTargetForElements;
}

const DEFAULT_DEPS: ColumnDropSurfaceDeps = {
  autoScrollForElements,
  combine,
  dropTargetForElements,
};

function canDropKanbanCard(source: { data: Record<string | symbol, unknown> }, dragInstanceId: symbol): boolean {
  const data = source.data as Partial<KanbanCardDragData>;
  return data.type === "kanban-card"
    && data.instanceId === dragInstanceId;
}

export function bindKanbanColumnDropSurface(
  input: BindKanbanColumnDropSurfaceInput,
  deps: ColumnDropSurfaceDeps = DEFAULT_DEPS,
): (() => void) | undefined {
  if (input.columnDropDisabled || !input.dragInstanceId || !input.element) {
    return undefined;
  }

  const dropCleanup = deps.dropTargetForElements({
    element: input.element,
    canDrop: ({ source }) => canDropKanbanCard(source, input.dragInstanceId as symbol),
    getIsSticky: () => true,
    getData: () => buildKanbanColumnDropTargetData({
      instanceId: input.dragInstanceId as symbol,
      columnId: input.columnId,
    }),
  });

  if (!input.scrollElement) {
    return dropCleanup;
  }

  const autoScrollCleanup = deps.autoScrollForElements({
    element: input.scrollElement,
    canScroll: ({ source }) => canDropKanbanCard(source, input.dragInstanceId as symbol),
  });

  return deps.combine(dropCleanup, autoScrollCleanup);
}
