import type { Card } from "./types";
import { extractPlainText } from "./nfm/extract-text";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalize(query);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

export function buildCardSearchText(card: Card): string {
  return normalize([
    card.id,
    card.title,
    extractPlainText(card.description),
    card.tags.join(" "),
    card.assignee ?? "",
    card.agentStatus ?? "",
  ].join(" "));
}

export function matchesSearchTokens(
  searchableText: string,
  tokens: string[],
): boolean {
  if (tokens.length === 0) return true;
  if (!searchableText) return false;
  return tokens.every((token) => searchableText.includes(token));
}
