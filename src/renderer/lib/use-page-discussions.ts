import { hashKey, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { ContentRoutingContext } from "../../shared/content-routing-context";
import type { DiscussionCommand, DiscussionStatus } from "../../shared/discussions";
import type { ProjectionScope } from "../../shared/projection-stream";
import { createUuidV7 } from "../../shared/uuid-v7";
import { applyDiscussion, readDiscussions } from "./page-discussions-adapter";
import { useProjectionRegistration } from "./projection-invalidation-context";
import { spaceQueryKey } from "./renderer-space";
import { useLibraryMetadata } from "./use-library-navigation";

export async function readDiscussion(context: ContentRoutingContext, discussionId: string) {
  const snapshot = await readDiscussions(context, { mode: "discussion", discussionId });
  if (snapshot.value.kind !== "discussion") throw new Error("Discussion details are unavailable");
  return snapshot.value.value;
}

export function usePageDiscussions(
  context: ContentRoutingContext,
  pageId: string,
  { status, enabled = true }: { status?: DiscussionStatus; enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const library = useLibraryMetadata(enabled && pageId.length > 0).data;
  const queryKey = spaceQueryKey(["library", "pageDiscussions", context, pageId, status ?? "all"]);
  const query = useInfiniteQuery({
    queryKey,
    enabled: enabled && pageId.length > 0,
    initialPageParam: null as import("../../shared/discussions").DiscussionCursor | null,
    queryFn: async ({ pageParam }) => {
      const snapshot = await readDiscussions(context, {
        mode: "discussions",
        pageId,
        status,
        cursor: pageParam ?? undefined,
      });
      if (snapshot.value.kind !== "discussions")
        throw new Error("Page Discussions are unavailable");
      return { ...snapshot, value: snapshot.value.value };
    },
    getNextPageParam: (page) => page.value.next ?? undefined,
  });
  const latest = query.data?.pages.at(-1);
  const libraryId = library?.libraryId ?? latest?.libraryId;
  const scope: ProjectionScope | null = !libraryId
    ? null
    : context.kind === "project"
      ? { kind: "project", libraryId, projectId: context.projectId }
      : { kind: "library", libraryId };

  useProjectionRegistration(
    enabled && scope
      ? {
          scope,
          consumerKey: hashKey(queryKey),
          getDependencies: () => ({ pageIds: [pageId] }),
          getCursor: () =>
            latest ? { storeEpoch: latest.storeEpoch, commitSeq: latest.commitSeq } : null,
          invalidate: () => queryClient.invalidateQueries({ queryKey, exact: true }),
        }
      : null,
  );

  return {
    discussions: query.data?.pages.flatMap((page) => page.value.items),
    nodexAnswersQuestions: query.data?.pages[0]?.value.nodexAnswersQuestions,
    loading: enabled && query.isPending,
    loadingMore: query.isFetchingNextPage,
    fetching: query.fetchStatus !== "idle",
    hasMore: query.hasNextPage,
    error: query.error,
    loadMore: query.fetchNextPage,
    refresh: query.refetch,
    execute: (command: DiscussionCommand, operationId = createUuidV7()) => {
      const storeEpoch = latest?.storeEpoch ?? library?.storeEpoch;
      if (!storeEpoch) return Promise.reject(new Error("Library identity is unavailable"));
      return applyDiscussion(context, { command, operationId, storeEpoch });
    },
  };
}
