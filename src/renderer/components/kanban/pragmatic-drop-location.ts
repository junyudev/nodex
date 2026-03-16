import type { Board, CardStatus } from "@/lib/types";
import { computeNativeDropIndexFromSurface } from "./native-drop-index";
import {
  canDropOnKanbanCard,
  isKanbanCardDropTargetData,
  isKanbanCardDragData,
  isKanbanColumnDropTargetData,
} from "./pragmatic-drag-data";

interface DropTargetRecordLike {
  data: Record<string | symbol, unknown>;
}

export interface ResolvedKanbanDropLocation {
  columnId: CardStatus;
  index: number;
}

export function resolveKanbanDropLocation(args: {
  visibleBoard: Board | null;
  dropTargets: readonly DropTargetRecordLike[];
  sourceData?: unknown;
  draggedCardIds: readonly string[];
  pointerY: number | null;
  resolveColumnSurface: (columnId: string) => HTMLElement | null;
}): ResolvedKanbanDropLocation | null {
  const ignoredCardIds = new Set(args.draggedCardIds);
  const sourceData = isKanbanCardDragData(args.sourceData) ? args.sourceData : null;
  const cardTarget = args.dropTargets.find((target) => {
    if (!isKanbanCardDropTargetData(target.data)) {
      return false;
    }

    if (!sourceData) {
      return !args.draggedCardIds.includes(target.data.cardId);
    }

    return canDropOnKanbanCard({
      targetCardId: target.data.cardId,
      source: sourceData,
      instanceId: sourceData.instanceId,
    });
  });
  const resolvedColumnId = cardTarget && isKanbanCardDropTargetData(cardTarget.data)
    ? cardTarget.data.columnId
    : (() => {
      const columnTarget = args.dropTargets.find((target) => isKanbanColumnDropTargetData(target.data));
      if (!columnTarget || !isKanbanColumnDropTargetData(columnTarget.data)) {
        return null;
      }
      return columnTarget.data.columnId;
    })();
  if (!resolvedColumnId) {
    return null;
  }

  const targetColumn = args.visibleBoard?.columns.find((column) => column.id === resolvedColumnId);
  const fallbackIndex = targetColumn?.cards.length ?? 0;
  const surface = args.resolveColumnSurface(resolvedColumnId);
  const index = typeof args.pointerY === "number" && surface
    ? computeNativeDropIndexFromSurface(surface, args.pointerY, {
      ignoredCardIds,
    })
    : fallbackIndex;

  return {
    columnId: resolvedColumnId,
    index,
  };
}
