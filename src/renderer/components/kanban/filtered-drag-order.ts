import type { Board, CardStatus } from "@/lib/types";

interface ResolveFilteredDropOrderInput {
  board: Board | null;
  visibleBoard: Board | null;
  draggedCardIds: readonly string[];
  targetColumnId: CardStatus;
  targetVisibleIndex: number;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function resolveFilteredDropOrder({
  board,
  visibleBoard,
  draggedCardIds,
  targetColumnId,
  targetVisibleIndex,
}: ResolveFilteredDropOrderInput): number {
  if (!board || !visibleBoard) {
    return 0;
  }

  const fullTargetColumn = board.columns.find((column) => column.id === targetColumnId);
  const visibleTargetColumn = visibleBoard.columns.find((column) => column.id === targetColumnId);
  if (!fullTargetColumn || !visibleTargetColumn) {
    return 0;
  }

  const draggedCardIdSet = new Set(draggedCardIds);
  const fullTargetCards = fullTargetColumn.cards;
  const visibleTargetCards = visibleTargetColumn.cards;
  const remainingTargetCards = fullTargetCards.filter((card) => !draggedCardIdSet.has(card.id));
  const visibleRemainingCards = visibleTargetCards.filter((card) => !draggedCardIdSet.has(card.id));
  const visibleInsertIndex = clamp(targetVisibleIndex, 0, visibleRemainingCards.length);

  if (visibleRemainingCards.length === 0) {
    const firstDraggedIndex = fullTargetCards.findIndex((card) => draggedCardIdSet.has(card.id));
    if (firstDraggedIndex < 0) {
      return remainingTargetCards.length;
    }

    return fullTargetCards
      .slice(0, firstDraggedIndex)
      .filter((card) => !draggedCardIdSet.has(card.id))
      .length;
  }

  if (visibleInsertIndex < visibleRemainingCards.length) {
    const anchorCardId = visibleRemainingCards[visibleInsertIndex]?.id;
    const anchorIndex = remainingTargetCards.findIndex((card) => card.id === anchorCardId);
    if (anchorIndex >= 0) {
      return anchorIndex;
    }
  }

  const lastVisibleCardId = visibleRemainingCards[visibleRemainingCards.length - 1]?.id;
  const lastVisibleIndex = remainingTargetCards.findIndex((card) => card.id === lastVisibleCardId);
  if (lastVisibleIndex >= 0) {
    return lastVisibleIndex + 1;
  }

  return remainingTargetCards.length;
}
