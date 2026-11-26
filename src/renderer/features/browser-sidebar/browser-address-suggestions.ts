import type { PageSearchMatch } from "@/lib/types";
import { normalizeBrowserAddressInput } from "../../../shared/browser-address-input";

export interface BrowserAddressWorkspaceCandidate {
  readonly id: string;
  /** Space content is a Page, Database or Canvas; Pages may carry their search evidence. */
  readonly kind: "launch-action" | "switch-tab" | "content";
  readonly title: string;
  readonly pageMatches?: readonly PageSearchMatch[];
}

type TextMatch = "exact" | "prefix" | "substring";

export type BrowserAddressSuggestion<T extends BrowserAddressWorkspaceCandidate> =
  | {
      readonly id: string;
      readonly kind: "workspace";
      readonly candidate: T;
    }
  | { readonly id: "typed"; readonly kind: "url" | "search"; readonly title: string };

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const matchRank: Readonly<Record<TextMatch, number>> = { exact: 0, prefix: 1, substring: 2 };

/** Explicit web addresses do not compete with workspace destinations. */
export function readBrowserAddressWorkspaceQuery(value: string): string | null {
  const query = value.trim();
  if (!query || /^www\./i.test(query) || /^[a-z][a-z\d+.-]*:/i.test(query)) return null;
  return query;
}

function textMatch(title: string, query: string): TextMatch {
  if (title === query) return "exact";
  return title.startsWith(query) ? "prefix" : "substring";
}

function workspaceRow<T extends BrowserAddressWorkspaceCandidate>(candidate: T) {
  return { id: candidate.id, kind: "workspace" as const, candidate };
}

// Content rows already carry relevance order. Strong evidence in the key, identity or title
// leads; strong evidence only elsewhere (body, properties, context) follows web search, and
// loose (typo or infix) evidence comes last. Title-only catalog matches carry no evidence and
// count as strong.
function contentTier(matches: readonly PageSearchMatch[] = []): number {
  if (matches.length === 0) return 0;
  const strong = matches.filter(({ quality }) => quality !== "typo" && quality !== "infix");
  if (strong.some(({ source }) => TITLE_SOURCES.has(source))) return 0;
  return strong.length > 0 ? 1 : 2;
}

const TITLE_SOURCES: ReadonlySet<PageSearchMatch["source"]> = new Set([
  "page_key",
  "identity",
  "title",
]);

/** The most rows a typed query lists, including the typed navigation or search choice. */
const MAX_TYPED_ROWS = 8;

/**
 * An empty address lists the workspace's own suggestions in their order. A typed one ranks
 * workspace matches around an always-present web navigation/search choice.
 */
export function buildBrowserAddressSuggestions<T extends BrowserAddressWorkspaceCandidate>(
  value: string,
  candidates: readonly T[],
): readonly BrowserAddressSuggestion<T>[] {
  const title = value.trim();
  if (!title) return candidates.map(workspaceRow);
  const url = normalizeBrowserAddressInput(value);
  const typed: BrowserAddressSuggestion<T> = {
    id: "typed",
    kind:
      url === `https://www.google.com/search?${new URLSearchParams({ q: title }).toString()}`
        ? "search"
        : "url",
    title,
  };
  const query = readBrowserAddressWorkspaceQuery(title);
  if (!query) return [typed];

  const toolQuery = query.toLocaleLowerCase();
  const toolsAndTabs = candidates
    .flatMap((candidate) => {
      if (candidate.kind === "content") return [];
      const title = candidate.title.toLocaleLowerCase();
      // The query may span words, as in "new page", but must start where a word starts.
      if (
        !Array.from(wordSegmenter.segment(title)).some(
          (word) => word.isWordLike && title.startsWith(toolQuery, word.index),
        )
      )
        return [];
      return [{ ...workspaceRow(candidate), rank: matchRank[textMatch(title, toolQuery)] }];
    })
    .toSorted(
      (left, right) =>
        left.rank - right.rank ||
        Number(left.candidate.kind === "switch-tab") -
          Number(right.candidate.kind === "switch-tab"),
    );

  const content = candidates
    .flatMap((candidate) =>
      candidate.kind === "content"
        ? [{ ...workspaceRow(candidate), rank: contentTier(candidate.pageMatches) }]
        : [],
    )
    .toSorted((left, right) => left.rank - right.rank);
  const leadingContent = content.filter((row) => row.rank === 0);
  const trailingContent = content.filter((row) => row.rank !== 0);
  const ordered =
    typed.kind === "url"
      ? [typed, ...toolsAndTabs, ...leadingContent, ...trailingContent]
      : [...toolsAndTabs, ...leadingContent, typed, ...trailingContent];
  const bounded = ordered.slice(0, MAX_TYPED_ROWS);
  if (bounded.some((row) => row.id === "typed")) return bounded;
  return [...bounded.slice(0, MAX_TYPED_ROWS - 1), typed];
}
