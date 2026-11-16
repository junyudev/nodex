import { metadata, searchPageChatRows } from "@/lib/page-chat-search";

export function filterCanvasCards<T extends { readonly card: { readonly title: string } }>(
  cards: readonly T[],
  query: string,
): readonly T[] {
  return searchPageChatRows(cards, query, ({ card }) => [metadata(card.title)]);
}
