import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  invokeRendererQuery,
  defineLocalCommitRendererCommand,
  invokeLocalCommitCommand,
} from "./renderer-command";
import { useProjectionRegistration } from "./projection-invalidation-context";
import { useLocalMember } from "./members-runtime";
import { createBoundedOperationId } from "../../shared/operation-identity";
export function usePageTurn(pageId: string) {
  const client = useQueryClient();
  const local = useLocalMember();
  const libraryId = local.data?.library_id;
  const query = useQuery({
    queryKey: key,
    queryFn: () => invokeRendererQuery("work:turn", pageId),
    enabled: pageId.length > 0,
    staleTime: Infinity,
  });
  useProjectionRegistration(
    libraryId
      ? {
          scope: { kind: "library", libraryId },
          consumerKey: `page-turn:${pageId}`,
          getDependencies: () => ({ pageIds: [pageId] }),
          getCursor: () =>
            query.data
              ? { storeEpoch: query.data.storeEpoch, commitSeq: query.data.commitSeq }
              : null,
          invalidate: () => client.invalidateQueries({ queryKey: key, exact: true }),
        }
      : null,
  );
  return query;
}
const accept = defineLocalCommitRendererCommand({
  key: "work.accept",
  channel: "work:accept",
  authority: "core",
  owner: "Work",
  protocol: { kind: "receipt_fenced_projection", presentation: "pending" },
});
export const acceptPageWork = (pageId: string, turnEpisode?: string) =>
  invokeLocalCommitCommand(accept, {
    pageId,
    ...(turnEpisode ? { turnEpisode } : {}),
    operationId: createBoundedOperationId("work.accept"),
  });
