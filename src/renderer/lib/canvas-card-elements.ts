import type { Card, Board } from "./types";

/** Marker stored in Excalidraw element customData to identify Nodex cards. */
const CARD_ELEMENT_TYPE = "nodex-card";

interface CardCustomData {
  type: typeof CARD_ELEMENT_TYPE;
  cardId: string;
  columnId: string;
}

interface ExcalidrawElementLike {
  id?: string;
  customData?: Record<string, unknown>;
  label?: { text: string };
  [key: string]: unknown;
}

const PRIORITY_COLORS: Record<string, string> = {
  "p0-critical": "#ffc9c9",
  "p1-high": "#ffd8a8",
  "p2-medium": "#d0ebff",
  "p3-low": "#e9ecef",
  "p4-later": "#f1f3f5",
};
const DEFAULT_CARD_COLOR = "#f8f9fa";

/** Build an ExcalidrawElementSkeleton representing a card on the canvas. */
export function createCardElement(
  card: Card,
  columnId: string,
  position: { x: number; y: number },
) {
  const label = card.title.length > 60 ? `${card.title.slice(0, 57)}...` : card.title;
  const bg = card.priority ? (PRIORITY_COLORS[card.priority] ?? DEFAULT_CARD_COLOR) : DEFAULT_CARD_COLOR;

  return {
    type: "rectangle" as const,
    x: position.x,
    y: position.y,
    width: 220,
    height: 80,
    backgroundColor: bg,
    fillStyle: "solid" as const,
    strokeColor: "#868e96",
    strokeWidth: 1,
    roundness: { type: 3 },
    link: `nodex:card/${card.id}`,
    label: {
      text: label,
      fontSize: 14,
      fontFamily: 1,
      textAlign: "center" as const,
    },
    customData: {
      type: CARD_ELEMENT_TYPE,
      cardId: card.id,
      columnId,
    } satisfies CardCustomData,
  };
}

/** Type guard: does this Excalidraw element represent an Nodex card? */
export function isCardElement(element: ExcalidrawElementLike): boolean {
  return element.customData?.type === CARD_ELEMENT_TYPE;
}

/** Extract cardId from an Nodex card element. Returns null for non-card elements. */
export function getCardIdFromElement(element: ExcalidrawElementLike): string | null {
  if (!isCardElement(element)) return null;
  return (element.customData as unknown as CardCustomData).cardId;
}

/** Build a card lookup map from a Board: cardId → { card, columnId } */
function buildCardMap(board: Board): Map<string, { card: Card; columnId: string }> {
  const map = new Map<string, { card: Card; columnId: string }>();
  for (const col of board.columns) {
    for (const card of col.cards) {
      map.set(card.id, { card, columnId: col.id });
    }
  }
  return map;
}

/**
 * Given the current Excalidraw elements array and fresh board data,
 * return a new elements array with card labels updated to match current titles.
 * Returns null if no changes were needed (avoids unnecessary updateScene calls).
 */
export function updateCardElements(
  elements: readonly ExcalidrawElementLike[],
  board: Board,
): ExcalidrawElementLike[] | null {
  const cardMap = buildCardMap(board);
  let changed = false;

  const updated = elements.map((el) => {
    if (!isCardElement(el)) return el;

    const cardId = (el.customData as unknown as CardCustomData).cardId;
    const entry = cardMap.get(cardId);
    if (!entry) return el; // card was deleted, leave element as-is

    const expectedLabel =
      entry.card.title.length > 60
        ? `${entry.card.title.slice(0, 57)}...`
        : entry.card.title;
    const expectedBg = entry.card.priority
      ? (PRIORITY_COLORS[entry.card.priority] ?? DEFAULT_CARD_COLOR)
      : DEFAULT_CARD_COLOR;

    const currentLabel = (el.label as { text?: string } | undefined)?.text;
    const currentBg = el.backgroundColor as string | undefined;
    const currentColumnId = (el.customData as unknown as CardCustomData).columnId;

    if (
      currentLabel === expectedLabel &&
      currentBg === expectedBg &&
      currentColumnId === entry.columnId
    ) {
      return el;
    }

    changed = true;
    return {
      ...el,
      backgroundColor: expectedBg,
      label: { ...el.label, text: expectedLabel },
      customData: { ...el.customData, columnId: entry.columnId },
    };
  });

  return changed ? updated : null;
}
