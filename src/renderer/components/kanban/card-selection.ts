import type { Board, Card } from "@/lib/types";

export interface CardSelectionState {
  cardIds: ReadonlySet<string>;
}

export interface SelectedCardEntry {
  card: Card;
  columnId: string;
  columnName: string;
}

export function emptyCardSelection(): CardSelectionState {
  return {
    cardIds: new Set<string>(),
  };
}

export function toggleCardSelection(
  selection: CardSelectionState,
  cardId: string,
): CardSelectionState {
  const nextCardIds = new Set(selection.cardIds);

  if (nextCardIds.has(cardId)) {
    nextCardIds.delete(cardId);
  } else {
    nextCardIds.add(cardId);
  }

  if (nextCardIds.size === 0) {
    return emptyCardSelection();
  }

  return {
    cardIds: nextCardIds,
  };
}

export function normalizeCardSelection(
  selection: CardSelectionState,
  board: Board | null,
): CardSelectionState {
  if (!board || selection.cardIds.size === 0) return selection;

  const visibleCardIds = new Set(
    board.columns.flatMap((column) => column.cards.map((card) => card.id)),
  );
  const normalizedIds = new Set(
    [...selection.cardIds].filter((cardId) => visibleCardIds.has(cardId)),
  );

  if (normalizedIds.size === 0) return emptyCardSelection();
  if (normalizedIds.size === selection.cardIds.size) return selection;

  return {
    cardIds: normalizedIds,
  };
}

export function resolveSelectedCardEntries(
  board: Board | null,
  selection: CardSelectionState,
): SelectedCardEntry[] {
  if (!board || selection.cardIds.size === 0) return [];

  return board.columns.flatMap((column) =>
    column.cards
      .filter((card) => selection.cardIds.has(card.id))
      .map((card) => ({
        card,
        columnId: column.id,
        columnName: column.name,
      })),
  );
}

export function resolveDragGroup(
  board: Board | null,
  selection: CardSelectionState,
  activeCard: {
    card: Card;
    columnId: string;
  },
): SelectedCardEntry[] {
  if (!selection.cardIds.has(activeCard.card.id) || selection.cardIds.size <= 1) {
    return [{
      card: activeCard.card,
      columnId: activeCard.columnId,
      columnName: board?.columns.find((column) => column.id === activeCard.columnId)?.name
        ?? activeCard.columnId,
    }];
  }

  const selectedEntries = resolveSelectedCardEntries(board, selection);
  if (selectedEntries.length === 0) {
    return [{
      card: activeCard.card,
      columnId: activeCard.columnId,
      columnName: board?.columns.find((column) => column.id === activeCard.columnId)?.name
        ?? activeCard.columnId,
    }];
  }

  return selectedEntries;
}
