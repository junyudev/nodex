import { useMemo } from "react";
import {
  configuredPageSearchProjectIds,
  useInteractivePageSearch,
} from "@/lib/interactive-page-search";
import { useInfiniteLibraryCatalog } from "@/lib/use-library-navigation";
import { MAX_LIBRARY_QUERY_LENGTH, type LibraryRouteTarget } from "../../../shared/library-module";
import { useLibraryCreateCommands } from "../library/library-new-menu";

export type SpaceContentKind = "page" | "database" | "canvas";

export interface SpaceContentDataSource {
  readonly useCatalog: (
    input: Parameters<typeof useInfiniteLibraryCatalog>[0],
  ) => Pick<
    ReturnType<typeof useInfiniteLibraryCatalog>,
    | "data"
    | "isPending"
    | "isError"
    | "hasNextPage"
    | "isFetchingNextPage"
    | "refetch"
    | "fetchNextPage"
  >;
  readonly useCreateCommands: (
    input: Parameters<typeof useLibraryCreateCommands>[0],
  ) => Pick<
    ReturnType<typeof useLibraryCreateCommands>,
    "isPending" | "createPage" | "createDatabase"
  >;
}

export const DEFAULT_SPACE_CONTENT_DATA_SOURCE: SpaceContentDataSource = {
  useCatalog: (input) => useInfiniteLibraryCatalog(input),
  useCreateCommands: (input) => useLibraryCreateCommands(input),
};

export interface SpaceContentItem {
  readonly target: LibraryRouteTarget;
  readonly title: string;
  readonly locationLabel: string;
  /** Present for catalog entries; content-search matches carry no edit time. */
  readonly updatedAt?: string;
}

export const ALL_SPACE_CONTENT_KINDS: readonly SpaceContentKind[] = ["page", "database", "canvas"];

export function boundSpaceContentQuery(value: string): string {
  return value.slice(0, MAX_LIBRARY_QUERY_LENGTH);
}

/**
 * Space content in last-edited order. A query matches titles through the Library
 * catalog and, when Pages are included, Page content through interactive search.
 */
export function useSpaceContentResults({
  query,
  kinds = ALL_SPACE_CONTENT_KINDS,
  dataSource = DEFAULT_SPACE_CONTENT_DATA_SOURCE,
}: {
  readonly query: string;
  readonly kinds?: readonly SpaceContentKind[];
  readonly dataSource?: SpaceContentDataSource;
}) {
  const liveQuery = query.trim().slice(0, MAX_LIBRARY_QUERY_LENGTH);
  const catalog = dataSource.useCatalog({
    lifecycle: "active",
    kinds: [...kinds],
    ...(liveQuery ? { query: liveQuery } : {}),
    limit: 40,
  });
  const searchesPageContent =
    liveQuery !== "" && kinds.includes("page") && dataSource === DEFAULT_SPACE_CONTENT_DATA_SOURCE;
  const preview = useInteractivePageSearch({
    projectIds: configuredPageSearchProjectIds(),
    query: searchesPageContent ? liveQuery : "",
    limit: 40,
    complete: searchesPageContent,
  });
  const catalogItems = useMemo(
    () => catalog.data?.pages.flatMap((page) => page.items) ?? [],
    [catalog.data?.pages],
  );
  const items = useMemo<readonly SpaceContentItem[]>(() => {
    if (!searchesPageContent) return catalogItems;
    const previewPageIds = new Set(preview.rows.map((row) => row.pageId));
    return [
      ...preview.rows.map((row) => ({
        target: { kind: "page" as const, pageId: row.pageId },
        title: row.title,
        locationLabel: row.locationLabel,
      })),
      ...catalogItems.filter(
        (item) => item.target.kind !== "page" || !previewPageIds.has(item.target.pageId),
      ),
    ];
  }, [catalogItems, preview.rows, searchesPageContent]);
  return { liveQuery, items, catalog };
}
