import type { Priority } from "../types";
import type { ToggleListCard, ToggleListPropertyKey } from "./types";

const priorityTokens: Record<Priority, string> = {
  "p0-critical": "P0",
  "p1-high": "P1",
  "p2-medium": "P2",
  "p3-low": "P3",
  "p4-later": "P4",
};

export function formatMeta(
  card: ToggleListCard,
  propertyOrder: ToggleListPropertyKey[],
  hiddenProperties: ToggleListPropertyKey[],
  showEmptyEstimate = false,
): string {
  const hidden = new Set(hiddenProperties);
  const tokens = propertyOrder
    .filter((property) => !hidden.has(property))
    .flatMap((property) => formatPropertyTokens(card, property, showEmptyEstimate));

  return tokens.join(" ");
}

function formatPropertyTokens(
  card: ToggleListCard,
  property: ToggleListPropertyKey,
  showEmptyEstimate: boolean,
): string[] {
  switch (property) {
    case "priority":
      return card.priority ? [`[${priorityTokens[card.priority]}]`] : [];
    case "estimate":
      if (card.estimate) return [`[${card.estimate.toUpperCase()}]`];
      return showEmptyEstimate ? ["[-]"] : [];
    case "status":
      return [`[${card.columnName}]`];
    case "tags":
      return card.tags.map((tag) => `[${tag}]`);
    default:
      return [];
  }
}
