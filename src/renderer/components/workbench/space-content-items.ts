import { pageSearchReveal, type PageSearchReveal } from "@/lib/page-search-reveal";
import type { PageSearchMatch, PageSearchResult, PageSearchTextPart } from "@/lib/types";
import type { LibraryCatalogEntry, LibraryRouteTarget } from "../../../shared/library-module";

export interface SpaceContentItem {
  readonly target: LibraryRouteTarget;
  readonly title: string;
  readonly locationLabel: string;
  readonly locationIsLibraryRoot?: boolean;
  readonly reveal?: PageSearchReveal;
  readonly searchMatches?: readonly PageSearchMatch[];
  readonly titleParts?: PageSearchTextPart[];
  readonly excerptParts?: PageSearchTextPart[];
  /** Last edit time from Page search or the Library catalog. */
  readonly updatedAt?: string;
  readonly status?: PageSearchResult["status"];
  readonly pageKey?: string | null;
  readonly projectId?: string | null;
}

export function buildSpaceContentItems({
  query,
  pageResults,
  catalogItems,
}: {
  readonly query: string;
  readonly pageResults: readonly PageSearchResult[];
  readonly catalogItems: readonly LibraryCatalogEntry[];
}): readonly SpaceContentItem[] {
  const pageIds = new Set<string>();
  const items = [
    ...pageResults.map((row) => ({
      target: { kind: "page" as const, pageId: row.pageId },
      title: row.title,
      locationLabel: row.locationLabel,
      reveal: pageSearchReveal(row.matches),
      searchMatches: row.matches,
      titleParts: row.titleParts,
      excerptParts: row.excerptParts,
      updatedAt: row.updatedAt,
      status: row.status,
      pageKey: row.pageKey,
      projectId: row.projectId,
    })),
    ...catalogItems,
  ].filter(({ target }) => {
    if (target.kind !== "page") return true;
    if (pageIds.has(target.pageId)) return false;
    pageIds.add(target.pageId);
    return true;
  });

  if (query) return items;
  return items.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}
