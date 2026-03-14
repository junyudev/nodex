import { useEffect, useMemo, useState } from "react";
import type { CommandPaletteCard } from "./command-palette";
import {
  createCommandPaletteCardSearchIndex,
  getCachedCommandPaletteCardSearchIndex,
  hydrateCommandPaletteCardSearchIndex,
  type CommandPaletteCardSearchIndex,
} from "./command-palette-card-search";

interface CommandPaletteCardSearchIndexState {
  cardsKey: string;
  index: CommandPaletteCardSearchIndex | null;
}

function buildCardsKey(cards: CommandPaletteCard[]): string {
  return cards
    .map((item) => [
      item.id,
      item.card.revision,
      item.projectName,
      item.columnName,
      item.card.title,
      item.card.assignee ?? "",
      item.card.agentStatus ?? "",
      item.card.tags.join(","),
    ].join("\u0001"))
    .join("\u0002");
}

export function useCommandPaletteCardSearchIndex(
  cards: CommandPaletteCard[],
): CommandPaletteCardSearchIndex | null {
  const cardsKey = useMemo(() => buildCardsKey(cards), [cards]);
  const [state, setState] = useState<CommandPaletteCardSearchIndexState>(() => ({
    cardsKey,
    index: getCachedCommandPaletteCardSearchIndex(cards),
  }));

  useEffect(() => {
    const cachedIndex = getCachedCommandPaletteCardSearchIndex(cards);
    if (cachedIndex) {
      setState({ cardsKey, index: cachedIndex });
      return;
    }

    if (cards.length === 0) {
      setState({
        cardsKey,
        index: createCommandPaletteCardSearchIndex([]),
      });
      return;
    }

    if (typeof indexedDB === "undefined") {
      setState({
        cardsKey,
        index: createCommandPaletteCardSearchIndex(cards),
      });
      return;
    }

    let cancelled = false;
    setState({ cardsKey, index: null });

    void hydrateCommandPaletteCardSearchIndex(cards)
      .then((index) => {
        if (cancelled) {
          return;
        }

        setState({ cardsKey, index });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setState({
          cardsKey,
          index: createCommandPaletteCardSearchIndex(cards),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [cards, cardsKey]);

  if (state.cardsKey !== cardsKey) {
    return null;
  }

  return state.index;
}
