/** One Discussion card in the Page margin, measured in the rail's coordinate space. */
export interface MarginCardInput {
  readonly id: string;
  /** Top of the card's anchor, in the same coordinate space as the result. */
  readonly anchorTop: number;
  /** Rendered height of the card. */
  readonly height: number;
}

export interface MarginLayoutOptions {
  /** The card that should sit exactly beside its anchor, usually the focused Discussion. */
  readonly activeId?: string | null;
  /** Vertical space kept between neighboring cards. */
  readonly gap: number;
  /** Cards never start above this line, such as the top of the Page body. */
  readonly minTop?: number;
}

/**
 * Places margin cards beside their anchors without overlap, keeping document order.
 *
 * Without an active card, each card sits at its anchor or just below the previous card. With an
 * active card, that card is pinned to its anchor; cards after it flow downward and cards before
 * it are pushed upward. When pushing upward would cross `minTop`, the whole column shifts down
 * just enough, so the active card stays as close to its anchor as the space allows.
 */
export function layoutMarginCards(
  cards: readonly MarginCardInput[],
  options: MarginLayoutOptions,
): ReadonlyMap<string, number> {
  const minTop = options.minTop ?? Number.NEGATIVE_INFINITY;
  const ordered = cards
    .map((card, index) => ({ card, index }))
    .toSorted((a, b) => a.card.anchorTop - b.card.anchorTop || a.index - b.index)
    .map(({ card }) => card);
  const tops = new Array<number>(ordered.length);
  const activeIndex = options.activeId
    ? ordered.findIndex((card) => card.id === options.activeId)
    : -1;

  if (activeIndex < 0) {
    flowDown(ordered, tops, 0, minTop, options.gap);
  } else {
    tops[activeIndex] = Math.max(ordered[activeIndex]!.anchorTop, minTop);
    flowDown(
      ordered,
      tops,
      activeIndex + 1,
      tops[activeIndex]! + ordered[activeIndex]!.height + options.gap,
      options.gap,
    );
    for (let index = activeIndex - 1; index >= 0; index -= 1) {
      const card = ordered[index]!;
      tops[index] = Math.min(card.anchorTop, tops[index + 1]! - options.gap - card.height);
    }
    const overflow = minTop - (tops[0] ?? minTop);
    if (overflow > 0) {
      // Not enough room above the active card: settle top-down from the boundary instead.
      flowDown(ordered, tops, 0, minTop, options.gap);
    }
  }

  return new Map(ordered.map((card, index) => [card.id, tops[index]!]));
}

function flowDown(
  ordered: readonly MarginCardInput[],
  tops: number[],
  from: number,
  floor: number,
  gap: number,
): void {
  let next = floor;
  for (let index = from; index < ordered.length; index += 1) {
    const card = ordered[index]!;
    const top = Math.max(card.anchorTop, next);
    tops[index] = top;
    next = top + card.height + gap;
  }
}
