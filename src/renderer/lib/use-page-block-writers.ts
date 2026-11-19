import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContentRoutingContext } from "../../shared/content-routing-context";
import { readDiscussions } from "./page-discussions-adapter";
import { useProjectionRegistration } from "./projection-invalidation-context";
import { spaceQueryKey } from "./renderer-space";

/** The last recorded writer of each live Block on the Page. */
export function usePageBlockWriters(
  context: ContentRoutingContext,
  pageId: string,
  enabled = true,
) {
  const client = useQueryClient();
  const queryKey = spaceQueryKey(["library", "blockWriters", context, pageId]);
  const query = useQuery({
    queryKey,
    enabled: enabled && pageId.length > 0,
    queryFn: async () => {
      const snapshot = await readDiscussions(context, { mode: "discussion_block_writers", pageId });
      if (snapshot.value.kind !== "discussion_block_writers")
        throw new Error("Core returned no Block writers");
      return { ...snapshot, value: snapshot.value.items };
    },
  });
  const snapshot = query.data;
  useProjectionRegistration(
    enabled && snapshot
      ? {
          scope: { ...context, libraryId: snapshot.libraryId },
          consumerKey: hashKey(queryKey),
          getDependencies: () => ({ pageIds: [pageId] }),
          getCursor: () => ({ storeEpoch: snapshot.storeEpoch, commitSeq: snapshot.commitSeq }),
          invalidate: () => client.invalidateQueries({ queryKey, exact: true }),
        }
      : null,
  );
  return { data: snapshot?.value, error: query.error, isPending: query.isPending };
}
