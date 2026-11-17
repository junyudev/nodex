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
  readonly kind: "metadata" | "prompt" | "plain";
}
const plainMatch = (entry: ChatCatalogItem): ChatSearchMatch => ({
  chat: chatWireEntry(entry),
  titleRanges: [],
  hint: null,
  excerpt: null,
});
/** Strong and loose chat matches each have an active lane followed by an archived lane. */
export const chatArchiveTier = (archived: boolean, strong?: boolean): number => {
  if (strong === false) return archived ? 3 : 2;
  if (strong === true && archived) return 1;
  return archived ? 3 : 0;
};

export function prepareChatCatalog(
  entries: readonly ChatCatalogItem[],
  query: SearchTextQuery,
  raw: string,
  now: number,
) {
  const words = query.words();
  const strongWords = words.map(() => false);
  // The analyzer never offers typo matches for shorter or multi-segment words.
  const canTypo = words.some(
    ({ segments }) => segments.length === 1 && Array.from(segments[0]!).length >= 4,
  );
  const evidence = new Map<string, ReturnType<SearchTextQuery["evidence"]>>();
  const catalogQuery: Pick<SearchTextQuery, "words" | "evidence"> = {
    words: () => words,
    evidence: (text, kind, typo) => {
      const allowTypo = canTypo && typo;
      const key = `${kind}:${Number(allowTypo)}:${text}`;
      const cached = evidence.get(key);
      if (cached) return cached;
      const value = query.evidence(text, kind, allowTypo);
      evidence.set(key, value);
      return value;
    },
  };
  const facts = entries.map((entry) => {
    const subject = chatSearchSubject(entry);
    const metadata = sessionMetadataEvidence(subject, catalogQuery, raw);
    const preview = singleLine(entry.preview);
    const prompt = preview ? catalogQuery.evidence(preview, "long_text", false) : null;
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
              ? catalogQuery.evidence(preview, "long_text", true)
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
                kind: "metadata",
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
              kind: "prompt",
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
      .map((entry) => ({ entry, kind: "plain", render: () => plainMatch(entry) }));
  using compiled = compileSearchQuery(query);
  const prepared = prepareChatCatalog(entries, compiled, query, now);
  // Renderers capture their text before the compiled query is freed.
  return prepared.rank(prepared.strongWords).map(({ entry, rank, kind, render }) => {
    const match = render();
    return { entry, rank, kind, render: () => match };
  });
};
