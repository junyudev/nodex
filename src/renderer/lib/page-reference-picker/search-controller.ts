import { type LibraryPageReferenceCandidate } from "../../../shared/library-module";
import { readLibraryModule } from "../api";
import {
  deduplicatePageReferenceCandidates,
  resolvePageReferenceDisabledReason,
} from "./candidate-model";
import type { PageReferenceCandidate, PageReferencePickerRequest } from "./types";
import type { PageSearchResult } from "../../../shared/types";
import { configuredPageSearchProjectIds, searchPageMetadataSync } from "../interactive-page-search";

export function resolvePageReferenceSourcePageId(
  request: PageReferencePickerRequest,
): string | undefined {
  if (request.intent === "reference_block") return undefined;
  return request.hostPageId ?? undefined;
}

export async function loadPageReferenceCandidates(
  request: PageReferencePickerRequest,
): Promise<PageReferenceCandidate[]> {
  const sourcePageId = resolvePageReferenceSourcePageId(request);
  const result = await readLibraryModule(request.routingContext, {
    read: {
      mode: "page_reference_candidates",
      query: request.query,
      limit: Math.max(1, Math.min(60, Math.floor(request.limit))),
      ...(sourcePageId === undefined ? {} : { sourcePageId }),
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.value.kind !== "page_reference_candidates") {
    throw new Error("Library returned the wrong Page reference read model");
  }
  return deduplicatePageReferenceCandidates(
    result.value.value.items.map((item: LibraryPageReferenceCandidate) => ({
      ...item,
      lifecycle: "active" as const,
      disabledReason: resolvePageReferenceDisabledReason({
        pageId: item.pageId,
        hostPageId: request.hostPageId,
        ancestorPageIds: request.ancestorPageIds,
        intent: request.intent,
      }),
    })),
    request.limit,
  );
}

/** Same-frame metadata results from the prewarmed Core-authorized projection. */
export function loadPageReferenceCandidatesSync(
  request: PageReferencePickerRequest,
): PageReferenceCandidate[] {
  const projectIds =
    request.routingContext.kind === "project"
      ? [request.routingContext.projectId]
      : configuredPageSearchProjectIds();
  const sourcePageId = resolvePageReferenceSourcePageId(request);
  const rows = searchPageMetadataSync({
    projectIds,
    query: request.query,
    excludePageIds: sourcePageId ? [sourcePageId] : [],
    limit: request.limit,
    complete: false,
  });
  return pageSearchResultsToReferenceCandidates(request, rows);
}

export function pageSearchResultsToReferenceCandidates(
  request: PageReferencePickerRequest,
  rows: readonly PageSearchResult[],
): PageReferenceCandidate[] {
  return deduplicatePageReferenceCandidates(
    rows.map((item) => ({
      pageId: item.pageId,
      title: item.title,
      pageKey: item.pageKey,
      status: item.status,
      locationLabel: item.locationLabel,
      lifecycle: "active" as const,
      matchExcerpt: item.excerpt,
      matchSource: (() => {
        const strongest = item.matches[0];
        if (!strongest) return "recent" as const;
        if (strongest.source === "page_key") return "page_key" as const;
        if (strongest.source === "body" || strongest.source === "property") {
          return "content" as const;
        }
        return "title" as const;
      })(),
      titleParts: item.titleParts,
      matchExcerptParts: item.excerptParts,
      matches: item.matches,
      disabledReason: resolvePageReferenceDisabledReason({
        pageId: item.pageId,
        hostPageId: request.hostPageId,
        ancestorPageIds: request.ancestorPageIds,
        intent: request.intent,
      }),
    })),
    request.limit,
  );
}

export interface PageReferenceSearchController {
  search(request: PageReferencePickerRequest): Promise<{
    readonly status: "current" | "stale";
    readonly items: readonly PageReferenceCandidate[];
  }>;
}

export function createPageReferenceSearchController(
  loader: typeof loadPageReferenceCandidates = loadPageReferenceCandidates,
): PageReferenceSearchController {
  let generation = 0;
  return {
    async search(request) {
      const current = ++generation;
      const items = await loader(request);
      return {
        status: current === generation ? "current" : "stale",
        items: current === generation ? items : [],
      };
    },
  };
}
