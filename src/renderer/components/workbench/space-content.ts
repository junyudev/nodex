import type { IntlShape } from "@/lib/i18n";
import { useMemo } from "react";
import { useInteractivePageSearch } from "@/lib/interactive-page-search";
import { useInfiniteLibraryCatalog } from "@/lib/use-library-navigation";
import { MAX_LIBRARY_QUERY_LENGTH } from "../../../shared/library-module";
import { useLibraryCreateCommands } from "../library/library-new-menu";
import { buildSpaceContentItems, type SpaceContentItem } from "./space-content-items";

export type { SpaceContentItem } from "./space-content-items";

export type SpaceContentKind = "page" | "database" | "canvas";

export interface SpaceContentDataSource {
  readonly useCatalog: (
    input: Parameters<typeof useInfiniteLibraryCatalog>[0],
    options?: Parameters<typeof useInfiniteLibraryCatalog>[1],
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
  useCatalog: (input, options) => useInfiniteLibraryCatalog(input, options),
  useCreateCommands: (input) => useLibraryCreateCommands(input),
};

export const ALL_SPACE_CONTENT_KINDS: readonly SpaceContentKind[] = ["page", "database", "canvas"];

export function presentSpaceContentLocation(item: SpaceContentItem, intl: IntlShape): string {
  return item.locationIsLibraryRoot
    ? intl.formatMessage({
        id: "workbench.contentTabLocation.library",
        defaultMessage: "Library",
      })
    : item.locationLabel;
}

export function boundSpaceContentQuery(value: string): string {
  return value.slice(0, MAX_LIBRARY_QUERY_LENGTH);
}

/**
 * Recent Space content in last-edited order. Typed queries put interactive Page
 * matches in relevance order, followed by Library catalog title matches.
 */
export function useSpaceContentResults({
  query,
  preferredProjectId,
  kinds = ALL_SPACE_CONTENT_KINDS,
  dataSource = DEFAULT_SPACE_CONTENT_DATA_SOURCE,
  enabled = true,
}: {
  readonly query: string;
  readonly preferredProjectId?: string | null;
  readonly kinds?: readonly SpaceContentKind[];
  readonly dataSource?: SpaceContentDataSource;
  /** False keeps a mounted consumer idle: nothing is read until it is needed. */
  readonly enabled?: boolean;
}) {
  const liveQuery = query.trim().slice(0, MAX_LIBRARY_QUERY_LENGTH);
  const searchesPageContent =
    enabled && kinds.includes("page") && dataSource === DEFAULT_SPACE_CONTENT_DATA_SOURCE;
  const catalogKinds = searchesPageContent ? kinds.filter((kind) => kind !== "page") : kinds;
  const catalog = dataSource.useCatalog(
    {
      lifecycle: "active",
      kinds: [...catalogKinds],
      ...(liveQuery ? { query: liveQuery } : {}),
      limit: 40,
    },
    { enabled: enabled && catalogKinds.length > 0 },
  );
  const preview = useInteractivePageSearch({
    enabled: searchesPageContent,
    query: searchesPageContent ? liveQuery : "",
    preferredProjectId: liveQuery ? preferredProjectId : undefined,
    limit: 40,
    complete: searchesPageContent,
  });
  const catalogItems = useMemo(
    () => catalog.data?.pages.flatMap((page) => page.items) ?? [],
    [catalog.data?.pages],
  );
  const items = useMemo<readonly SpaceContentItem[]>(() => {
    if (!searchesPageContent) return catalogItems;
    return buildSpaceContentItems({ query: liveQuery, pageResults: preview.rows, catalogItems });
  }, [catalogItems, liveQuery, preview.rows, searchesPageContent]);
  return { liveQuery, items, catalog };
}
