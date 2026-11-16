import type { PageSearchMatch } from "@/lib/types";
import { normalizeBrowserAddressInput } from "../../../shared/browser-address-input";

export interface BrowserAddressWorkspaceCandidate {
  readonly id: string;
  readonly kind: "launch-action" | "switch-tab" | "page";
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

// Page rows already carry kernel relevance order. Keep whole-title/identity
// evidence ahead of other fields within each strength tier.
function pageTier(matches: readonly PageSearchMatch[]): number {
  const loose = matches.some(({ quality }) => quality === "typo" || quality === "infix");
  const otherField = matches.some(({ source }) => source === "property" || source === "body");
  return Number(loose) * 2 + Number(otherField);
}

/** Ranks workspace matches around an always-present web navigation/search choice. */
export function buildBrowserAddressSuggestions<T extends BrowserAddressWorkspaceCandidate>(
  value: string,
  candidates: readonly T[],
): readonly BrowserAddressSuggestion<T>[] {
  const title = value.trim();
  if (!title) return [];
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
      if (candidate.kind === "page") return [];
      const title = candidate.title.toLocaleLowerCase();
      if (
        !Array.from(wordSegmenter.segment(title)).some(
          (word) => word.isWordLike && word.segment.startsWith(toolQuery),
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

  const pages = candidates
    .flatMap((candidate) => {
      if (candidate.kind !== "page" || !candidate.pageMatches) return [];
      const rank = pageTier(candidate.pageMatches);
      return [{ ...workspaceRow(candidate), rank }];
    })
    .toSorted((left, right) => left.rank - right.rank)
    .slice(0, 5);
  const leadingPages = pages.filter((row) => row.rank === 0);
  const trailingPages = pages.filter((row) => row.rank !== 0);
  const ordered =
    typed.kind === "url"
      ? [typed, ...toolsAndTabs, ...leadingPages, ...trailingPages]
      : [...toolsAndTabs, ...leadingPages, typed, ...trailingPages];
  const bounded = ordered.slice(0, 8);
  if (bounded.some((row) => row.id === "typed")) return bounded;
  return [...bounded.slice(0, 7), typed];
}
