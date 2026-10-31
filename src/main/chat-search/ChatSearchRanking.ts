import {
  compareMessageSearchRank,
  findSearchTokenRanges,
  foldSearchQuery,
  messageMatcher,
  messageSearchTokens,
  rankSearchItems,
  scoreMessageSearch,
  scoreThreadSearch,
} from "@nodex/agent-runtime/palette-search";
import type { ChatCatalogEntry, ChatSearchMatch } from "../../shared/chat-search";
import type { ChatCatalogItem } from "./ChatCatalogProjection";

export const singleLine = (text: string): string => text.replace(/\s+/gu, " ").trim();
export const chatWireEntry = ({
  preview: _preview,
  opens: _opens,
  binding: _binding,
  backend: _backend,
  ...entry
}: ChatCatalogItem): ChatCatalogEntry => entry;

/** Session identity, PR references and usage match the Agent metadata search subject. */
export const chatSearchSubject = (entry: ChatCatalogItem) => ({
  id: entry.sessionId,
  title: entry.title,
  branch: entry.branch,
  projectTitle: entry.projectName,
  pullRequests: entry.pullRequests.map((pr) => ({
    number: pr.number,
    title: pr.title,
    references: [pr.url, pr.repository],
  })),
  activityAt: entry.recencyAt,
  opens: entry.opens ? { ...entry.opens, picks: [] } : null,
});

interface CatalogMatch {
  readonly entry: ChatCatalogItem;
  readonly render: () => ChatSearchMatch;
}
const plainMatch = (entry: ChatCatalogItem): ChatSearchMatch => ({
  chat: chatWireEntry(entry),
  titleRanges: [],
  hint: null,
  excerpt: null,
});
const excerpt = (text: string, offset: number) => {
  const start = Math.max(0, offset - 40);
  const end = Math.min(text.length, start + 180);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};

/** Returns every matching identity; only the selected rows materialize hints and excerpts. */
export const rankCatalog = (
  entries: readonly ChatCatalogItem[],
  query: string,
  now: number,
): readonly CatalogMatch[] => {
  if (!query)
    return [...entries]
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          (a.pinned && b.pinned ? (a.pinnedOrder ?? Infinity) - (b.pinnedOrder ?? Infinity) : 0) ||
          b.recencyAt - a.recencyAt ||
          a.title.localeCompare(b.title) ||
          a.sessionId.localeCompare(b.sessionId),
      )
      .map((entry) => ({ entry, render: () => plainMatch(entry) }));
  const normalized = foldSearchQuery(query);
  const metadata = rankSearchItems(entries, (entry, { typos }) =>
    scoreThreadSearch(normalized, chatSearchSubject(entry), now, { typos, picks: false }),
  );
  const seen = new Set(metadata.map(({ item }) => item.sessionId));
  const matching = messageMatcher(query);
  const prompts = messageSearchTokens(query).long.length
    ? entries
        .flatMap((entry) => {
          if (seen.has(entry.sessionId)) return [];
          const text = singleLine(entry.preview);
          const match = matching(text);
          return match
            ? [
                {
                  entry,
                  text,
                  match,
                  rank: scoreMessageSearch(match, chatSearchSubject(entry), normalized, now, {
                    picks: false,
                  }),
                },
              ]
            : [];
        })
        .sort(
          (a, b) =>
            compareMessageSearchRank(a.rank, b.rank) ||
            a.entry.sessionId.localeCompare(b.entry.sessionId),
        )
    : [];
  return [
    ...metadata.map(({ item: entry, match }) => ({
      entry,
      render: () => ({
        ...plainMatch(entry),
        titleRanges: match.ranges,
        hint: match.explain?.() ?? null,
      }),
    })),
    ...prompts.map(({ entry, text, match }) => ({
      entry,
      render: (): ChatSearchMatch => {
        const value = excerpt(text, match.offset);
        return {
          ...plainMatch(entry),
          excerpt: { text: value, ranges: findSearchTokenRanges(value, query), role: "user" },
        };
      },
    })),
  ];
};
