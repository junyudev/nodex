import type { MentionSuggestionMatch } from "../editor-model/mention-suggestion-model";
import type { CommandPaletteHighlightSegment } from "../command-palette-highlight";
import type { PageReferenceCandidate, PageReferenceIntent, PageReferenceSelection } from "./types";

export interface PageReferenceCandidatePresentation {
  readonly candidate: PageReferenceCandidate;
  readonly detail: string | null;
  readonly titleSegments: readonly CommandPaletteHighlightSegment[] | null;
  readonly detailSegments: readonly CommandPaletteHighlightSegment[] | null;
  readonly match: MentionSuggestionMatch;
}

function normalizeCandidateText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

const toSegments = (
  parts: readonly { readonly text: string; readonly highlighted: boolean }[],
): readonly CommandPaletteHighlightSegment[] | null => {
  if (!parts.some((part) => part.highlighted)) return null;
  return parts.map((part) => ({ text: part.text, highlight: part.highlighted }));
};

function classifyPageCandidateMatch(candidate: PageReferenceCandidate): MentionSuggestionMatch {
  if (candidate.matchSource === "recent" || candidate.matches.length === 0) return "recent";
  const strongest = candidate.matches[0];
  if (strongest.source === "page_key") return "page_key";
  if (strongest.source === "body" || strongest.source === "property") return "content";
  if (strongest.source === "title") {
    if (strongest.quality === "exact") return "exact_title";
    if (strongest.quality === "prefix") return "prefix_title";
  }
  return "title";
}

/** Presents Core-ranked candidates without local matching, inference, or reordering. */
export function presentPageReferenceCandidates(
  candidates: readonly PageReferenceCandidate[],
): PageReferenceCandidatePresentation[] {
  const titleCounts = new Map<string, number>();
  const titleLocationCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const title = normalizeCandidateText(candidate.title || "Untitled");
    const titleLocation = `${title}\u0000${normalizeCandidateText(candidate.locationLabel)}`;
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    titleLocationCounts.set(titleLocation, (titleLocationCounts.get(titleLocation) ?? 0) + 1);
  }

  return candidates.map((candidate) => {
    const match = classifyPageCandidateMatch(candidate);
    const title = candidate.title || "Untitled";
    const titleSegments = toSegments(candidate.titleParts);
    if (match === "page_key") {
      const pageKeyMatch = candidate.matches.find((entry) => entry.source === "page_key");
      return {
        candidate,
        match,
        titleSegments,
        detail: candidate.pageKey,
        detailSegments: pageKeyMatch ? toSegments(pageKeyMatch.parts) : null,
      };
    }
    if (match === "content" && candidate.matchExcerpt) {
      return {
        candidate,
        match,
        titleSegments,
        detail: candidate.matchExcerpt,
        detailSegments: toSegments(candidate.matchExcerptParts),
      };
    }

    const normalizedTitle = normalizeCandidateText(title);
    if ((titleCounts.get(normalizedTitle) ?? 0) < 2) {
      return { candidate, match, titleSegments, detail: null, detailSegments: null };
    }

    const titleLocation = `${normalizedTitle}\u0000${normalizeCandidateText(candidate.locationLabel)}`;
    const sameLocation = (titleLocationCounts.get(titleLocation) ?? 0) > 1;
    const detail = [candidate.locationLabel, sameLocation ? candidate.pageKey : null]
      .filter(Boolean)
      .join(" · ");
    return {
      candidate,
      match,
      titleSegments,
      detail: detail || null,
      detailSegments: null,
    };
  });
}

export function resolvePageReferenceDisabledReason(input: {
  readonly pageId: string;
  readonly hostPageId: string | null;
  readonly ancestorPageIds: readonly string[];
  readonly intent: PageReferenceIntent;
}): PageReferenceCandidate["disabledReason"] {
  if (input.intent !== "reference_block") return null;
  if (input.pageId === input.hostPageId) return "self";
  return input.ancestorPageIds.includes(input.pageId) ? "ancestor_cycle" : null;
}

export function selectPageReferenceCandidate(
  candidate: PageReferenceCandidate,
): PageReferenceSelection | null {
  if (candidate.lifecycle !== "active" || candidate.disabledReason) return null;
  return { pageId: candidate.pageId, titleSnapshot: candidate.title };
}

export function deduplicatePageReferenceCandidates(
  candidates: readonly PageReferenceCandidate[],
  limit: number,
): PageReferenceCandidate[] {
  const boundedLimit = Math.max(1, Math.min(60, Math.floor(limit)));
  const seen = new Set<string>();
  const result: PageReferenceCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.pageId)) continue;
    seen.add(candidate.pageId);
    result.push(candidate);
    if (result.length === boundedLimit) break;
  }
  return result;
}
