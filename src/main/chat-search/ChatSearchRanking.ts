import { compileSearchQuery, type SearchTextQuery } from "@nodex/search-kernel/node";
import {
  compareMessageSearchRank,
  scoreMessageSearch,
  type MessageSearchRank,
} from "@nodex/agent-runtime/palette-search";
import {
  corpusHighlights,
  fieldRank,
  matchedRanges,
  phraseBonus,
  rankQuality,
  strongRank,
  searchEvidenceExcerpt,
} from "@nodex/agent-runtime/orchestration/SessionSearchText";
import { sessionMetadataEvidence } from "@nodex/agent-runtime/orchestration/SessionSearchRanking";
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

export const chatSearchSubject = (entry: ChatCatalogItem) => ({
  sessionId: entry.sessionId,
  title: entry.title,
  branch: entry.branch,
  projectName: entry.projectName,
  pullRequests: entry.pullRequests,
  activityAt: entry.recencyAt,
  opens: entry.opens,
});

interface CatalogMatch {
  readonly entry: ChatCatalogItem;
  readonly render: () => ChatSearchMatch;
  readonly rank?: MessageSearchRank;
}
const plainMatch = (entry: ChatCatalogItem): ChatSearchMatch => ({
  chat: chatWireEntry(entry),
  titleRanges: [],
  hint: null,
  excerpt: null,
});
export function prepareChatCatalog(
  entries: readonly ChatCatalogItem[],
  query: SearchTextQuery,
  raw: string,
  now: number,
) {
  const strongWords = query.words().map(() => false);
  const facts = entries.map((entry) => {
    const subject = chatSearchSubject(entry);
    const metadata = sessionMetadataEvidence(subject, query, raw);
    const preview = singleLine(entry.preview);
    const prompt = preview ? query.evidence(preview, "long_text", false) : null;
    for (const [index, rank] of metadata.withoutTypos.entries()) {
      const word = prompt?.words[index];
      strongWords[index] ||=
        (rank !== null && strongRank(rank)) ||
        (word != null && strongRank(fieldRank(word.quality, "message")));
    }
    return { entry, metadata, prompt, preview };
  });
  const rank = (corpus: readonly boolean[]) =>
    facts
      .flatMap<CatalogMatch & { rank: MessageSearchRank }>(
        ({ entry, metadata, prompt, preview }) => {
          const result = metadata.render(corpus, now);
          const promptTypos =
            prompt && corpus.some((strong) => !strong)
              ? query.evidence(preview, "long_text", true)
              : null;
          const promptWords = prompt?.words.map((word, index) =>
            corpus[index] ? word : (promptTypos?.words[index] ?? word),
          );
          const promptMatch =
            promptWords?.length && promptWords.every((word) => word !== null)
              ? searchEvidenceExcerpt(preview, matchedRanges(promptWords), prompt?.ordered ?? false)
              : null;
          const promptRank =
            promptMatch && promptWords
              ? rankQuality(
                  Math.max(...promptWords.map((word) => fieldRank(word!.quality, "message"))),
                )
              : 0;
          if (result && result.wordQuality >= promptRank) {
            return [
              {
                entry,
                rank: result,
                render: (): ChatSearchMatch => ({
                  ...plainMatch(entry),
                  titleRanges: result.titleRanges,
                  hint: result.hint,
                  rank: result,
                }),
              },
            ];
          }
          if (!promptMatch) return [];
          const rank = scoreMessageSearch(
            { wordQuality: promptRank, quality: promptRank + (prompt?.ordered ? phraseBonus : 0) },
            chatSearchSubject(entry),
            now,
          );
          return [
            {
              entry,
              rank,
              render: (): ChatSearchMatch => ({
                ...plainMatch(entry),
                rank,
                excerpt: {
                  text: promptMatch.snippet,
                  ranges: corpusHighlights(query, promptMatch.snippet, "long_text", corpus),
                  role: "user",
                },
              }),
            },
          ];
        },
      )
      .sort(
        (a, b) =>
          compareMessageSearchRank(a.rank, b.rank) ||
          a.entry.sessionId.localeCompare(b.entry.sessionId),
      );
  return { facts, strongWords, rank };
}

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
  using compiled = compileSearchQuery(query);
  const prepared = prepareChatCatalog(entries, compiled, query, now);
  // Renderers capture their text before the compiled query is freed.
  return prepared.rank(prepared.strongWords).map(({ entry, rank, render }) => {
    const match = render();
    return { entry, rank, render: () => match };
  });
};
