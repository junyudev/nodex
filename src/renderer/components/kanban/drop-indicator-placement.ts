interface IdentifiableCard {
  id: string;
}

export interface DropIndicatorPlacement {
  beforeCardId: string | null;
  atEnd: boolean;
}

export function resolveDropIndicatorPlacement(
  cards: readonly IdentifiableCard[],
  draggedCardIds: ReadonlySet<string>,
  dropIndicatorIndex: number | undefined,
): DropIndicatorPlacement {
  if (typeof dropIndicatorIndex !== "number" || dropIndicatorIndex < 0) {
    return {
      beforeCardId: null,
      atEnd: false,
    };
  }

  let remainingIndex = 0;
  for (const card of cards) {
    if (draggedCardIds.has(card.id)) {
      continue;
    }

    if (remainingIndex === dropIndicatorIndex) {
      return {
        beforeCardId: card.id,
        atEnd: false,
      };
    }

    remainingIndex += 1;
  }

  return {
    beforeCardId: null,
    atEnd: dropIndicatorIndex === remainingIndex,
  };
}
