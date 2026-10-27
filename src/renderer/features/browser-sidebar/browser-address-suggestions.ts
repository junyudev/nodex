import { normalizeBrowserNavigationUrl } from "../../../shared/browser-url";

export interface BrowserAddressWorkspaceCandidate {
  readonly id: string;
  readonly kind: "launch-action" | "switch-tab" | "page";
  readonly title: string;
  readonly updatedAt?: number;
}

type TextMatch = "exact" | "prefix" | "substring";

export type BrowserAddressSuggestion<T extends BrowserAddressWorkspaceCandidate> =
  | {
      readonly id: string;
      readonly kind: "workspace";
      readonly candidate: T;
      readonly textMatch: TextMatch;
    }
  | { readonly id: "typed"; readonly kind: "url" | "search"; readonly title: string };

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const matchRank: Readonly<Record<TextMatch, number>> = { exact: 0, prefix: 1, substring: 2 };

/** Explicit web addresses do not compete with workspace destinations. */
export function readBrowserAddressWorkspaceQuery(value: string): string | null {
  const query = value.trim().toLocaleLowerCase();
  if (!query || query.startsWith("www.") || /^[a-z][a-z\d+.-]*:/i.test(query)) return null;
  return query;
}

function textMatch(title: string, query: string): TextMatch {
  if (title === query) return "exact";
  return title.startsWith(query) ? "prefix" : "substring";
}

/** Ranks workspace matches around an always-present web navigation/search choice. */
export function buildBrowserAddressSuggestions<T extends BrowserAddressWorkspaceCandidate>(
  value: string,
  candidates: readonly T[],
): readonly BrowserAddressSuggestion<T>[] {
  const title = value.trim();
  if (!title) return [];
  const url = normalizeBrowserNavigationUrl(title);
  const typed: BrowserAddressSuggestion<T> = {
    id: "typed",
    kind: url === `https://www.google.com/search?q=${encodeURIComponent(title)}` ? "search" : "url",
    title,
  };
  const query = readBrowserAddressWorkspaceQuery(title);
  if (!query) return [typed];

  const matches = candidates.flatMap((candidate) => {
    const candidateTitle = candidate.title.toLocaleLowerCase();
    const matchesQuery =
      candidate.kind === "page"
        ? candidateTitle.includes(query)
        : Array.from(wordSegmenter.segment(candidateTitle)).some(
            (word) => word.isWordLike && word.segment.startsWith(query),
          );
    if (!matchesQuery) return [];
    return [
      {
        id: candidate.id,
        kind: "workspace" as const,
        candidate,
        textMatch: textMatch(candidateTitle, query),
      },
    ];
  });
  const toolsAndTabs = matches
    .filter((row) => row.candidate.kind !== "page")
    .toSorted(
      (left, right) =>
        matchRank[left.textMatch] - matchRank[right.textMatch] ||
        Number(left.candidate.kind === "switch-tab") -
          Number(right.candidate.kind === "switch-tab"),
    );
  const pages = matches
    .filter((row) => row.candidate.kind === "page")
    .toSorted((left, right) => (right.candidate.updatedAt ?? 0) - (left.candidate.updatedAt ?? 0))
    .slice(0, 5);
  const leadingPages = pages.filter((row) => row.textMatch !== "substring");
  const trailingPages = pages.filter((row) => row.textMatch === "substring");
  const ordered =
    typed.kind === "url"
      ? [typed, ...toolsAndTabs, ...leadingPages, ...trailingPages]
      : [...toolsAndTabs, ...leadingPages, typed, ...trailingPages];
  const bounded = ordered.slice(0, 8);
  if (bounded.some((row) => row.id === "typed")) return bounded;
  return [...bounded.slice(0, 7), typed];
}
