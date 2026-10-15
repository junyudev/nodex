import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ContentRoutingContext } from "../../shared/content-routing-context";
import type { LibraryPageDetail, PageDetail } from "../../shared/page-detail";
import { invalidateExactQuery } from "./query-invalidation";
import { libraryPageDetailQueryOptions } from "./library-page-detail-query";
import { usePageDetail } from "./page-detail-store";
import { pageDetailDataDependencies } from "./page-detail-projection-dependencies";
import { useProjectionRegistration } from "./projection-invalidation-context";
import { queryKeys } from "./query-keys";

export interface ContentPageDetailSnapshot {
  readonly detail: PageDetail | LibraryPageDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Resolves Page presentation metadata through the same Profile content boundary
 * as the content surface that contains it.
 */
export const useContentPageDetail = (
  libraryId: string | null,
  routingContext: ContentRoutingContext,
  pageId: string | null,
): ContentPageDetailSnapshot => {
  const queryClient = useQueryClient();
  const projectId = routingContext.kind === "project" ? routingContext.projectId : null;
  const project = usePageDetail(libraryId, projectId, pageId);
  const libraryPageId = pageId ?? "";
  const libraryQueryKey = queryKeys.library.pageDetail(libraryPageId);
  const library = useQuery({
    ...libraryPageDetailQueryOptions(libraryPageId),
    enabled: routingContext.kind === "library" && Boolean(pageId),
  });
  const libraryDetail = library.data ?? null;

  useProjectionRegistration(
    libraryDetail
      ? {
          scope: { kind: "library", libraryId: libraryDetail.libraryId },
          consumerKey: hashKey(["projection", libraryQueryKey]),
          getDependencies: () =>
            pageDetailDataDependencies(
              queryClient.getQueryData<LibraryPageDetail>(libraryQueryKey) ?? null,
              libraryPageId,
            ),
          getCursor: () => {
            const detail = queryClient.getQueryData<LibraryPageDetail>(libraryQueryKey);
            return detail ? { storeEpoch: detail.storeEpoch, commitSeq: detail.commitSeq } : null;
          },
          invalidate: async () => {
            await invalidateExactQuery(queryClient, libraryQueryKey);
          },
        }
      : null,
  );

  if (routingContext.kind === "project") return project;
  return {
    detail: libraryDetail,
    loading: library.isPending || library.isFetching,
    error:
      library.error instanceof Error
        ? library.error.message
        : library.isError
          ? "Page details are unavailable"
          : null,
  };
};
