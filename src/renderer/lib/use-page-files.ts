import { useEffect } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";

import type { ContentAccessContext } from "../../shared/content-access-context";
import type { LibraryPageFileManifest } from "../../shared/library-module";
import { readLibraryModule } from "./api";
import { subscribePageFileChanges } from "./page-library-changes";
import { queryKeys } from "./query-keys";

const PAGE_SIZE = 100;

export interface PageFilesReadModel {
  readonly manifest: LibraryPageFileManifest | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly error: Error | null;
  readonly loadMore: () => Promise<void>;
  readonly refresh: () => Promise<LibraryPageFileManifest>;
}

export function usePageFiles(
  accessContext: ContentAccessContext,
  pageId: string,
  options: {
    readonly query?: string;
    readonly enabled?: boolean;
    readonly subscribe?: boolean;
  } = {},
): PageFilesReadModel {
  const queryClient = useQueryClient();
  const normalizedQuery = options.query?.trim() ?? "";
  const queryKey = queryKeys.library.pageFilesWindow(accessContext, pageId, normalizedQuery);
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<LibraryPageFileManifest> => {
      const result = await readLibraryModule(accessContext, {
        read: {
          mode: "page_files",
          pageId,
          limit: PAGE_SIZE,
          includeDeleted: true,
          ...(normalizedQuery ? { query: normalizedQuery } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      });
      if (!result.ok) throw new Error(result.error.message || "Couldn’t read Page Files");
      if (result.value.value.kind !== "page_files") {
        throw new Error("Unexpected Page Files response");
      }
      return result.value.value.value;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: (options.enabled ?? true) && pageId.length > 0,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!options.subscribe || !pageId) return;
    return subscribePageFileChanges(pageId, ({ bodyUsageRevision, manifestRevision }) => {
      if (manifestRevision === null && bodyUsageRevision === null) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.library.pageFiles(accessContext, pageId),
      });
    });
  }, [accessContext, options.subscribe, pageId, queryClient]);

  const first = query.data?.pages[0] ?? null;
  const files = query.data?.pages.flatMap((page) => page.files) ?? [];
  const manifest = first ? { ...first, files } : null;

  return {
    manifest,
    loading: query.status === "pending",
    loadingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage,
    error: query.error instanceof Error ? query.error : null,
    loadMore: async () => {
      await query.fetchNextPage();
    },
    refresh: async () => {
      const refreshed = await query.refetch();
      const firstPage = refreshed.data?.pages[0];
      if (!firstPage) throw refreshed.error ?? new Error("Couldn’t refresh Page Files");
      return firstPage;
    },
  };
}
