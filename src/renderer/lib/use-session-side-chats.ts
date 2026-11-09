import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ThreadSummaryPanelSessionSideChat } from "@/features/local-conversation/projection/thread-summary-panel-side-chat-row-model";
import { listSessionSideChats } from "./project-session-query-cache";
import { queryKeys } from "./query-keys";

const SIDE_CHAT_PAGE_SIZE = 50;
const NO_SIDE_CHATS: readonly ThreadSummaryPanelSessionSideChat[] = [];

export interface SessionSideChats {
  /** Newest first; the read continues with `loadMore` while `hasMore`. */
  readonly sideChats: readonly ThreadSummaryPanelSessionSideChat[];
  readonly hasMore: boolean;
  readonly loadMore: () => void;
}

/**
 * A chat's side chats, open or closed, so a closed one can be found and reopened. Session changes
 * refresh the read; an open tab supplies its live title and placement separately.
 */
export function useSessionSideChats(sourceSessionId: string | null): SessionSideChats {
  const query = useInfiniteQuery({
    queryKey: queryKeys.projectSessions.sideChats(sourceSessionId ?? ""),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listSessionSideChats(sourceSessionId!, { after: pageParam, first: SIDE_CHAT_PAGE_SIZE }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: sourceSessionId !== null,
  });
  const pages = query.data?.pages;
  const sideChats = useMemo(
    () =>
      pages
        ? pages.flatMap((page) =>
            page.items.flatMap((sideChat) =>
              sideChat.archived
                ? []
                : [{ sessionId: sideChat.sessionId, title: sideChat.displayTitle }],
            ),
          )
        : NO_SIDE_CHATS,
    [pages],
  );
  return {
    sideChats,
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
  };
}
