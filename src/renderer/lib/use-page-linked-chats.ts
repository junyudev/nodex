import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PageStageRelatedChat,
  PageStageRelatedChatCandidate,
} from "@/components/board/page-stage/types";
import { unlinkPageChat } from "./page-chat-runtime";
import { pageChatWindowQueryOptions } from "./query-options";
import { queryKeys } from "./query-keys";

/** The window-wide Chat commands every Page Stage offers in its Linked chats Property. */
export interface PageChatCommands {
  readonly candidates: readonly PageStageRelatedChatCandidate[];
  readonly openChat: (sessionId: string) => Promise<void> | void;
  readonly linkPage: (input: {
    readonly pageId: string;
    readonly sessionId: string;
  }) => Promise<void>;
}

/** Page Stage's Linked chats Property for one Page: its bounded relation window and removal. */
export function usePageLinkedChats(pageId: string, { enabled }: { readonly enabled: boolean }) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    ...pageChatWindowQueryOptions({ pageId, includeArchived: false, first: 20 }),
    enabled,
  });
  const relatedChats: readonly PageStageRelatedChat[] =
    query.data?.pages.flatMap((window) => window.items) ?? [];
  return {
    relatedChats,
    relatedChatsLoading: query.isPending,
    relatedChatsError: query.error ? "Couldn’t load linked chats" : null,
    relatedChatsHasMore: query.hasNextPage,
    relatedChatsLoadingMore: query.isFetchingNextPage,
    onRemoveRelatedChat: async (sessionId: string): Promise<void> => {
      await unlinkPageChat(sessionId, { pageId });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pageChats.all() });
    },
    onRetryRelatedChats: async (): Promise<void> => {
      await query.refetch();
    },
    onLoadMoreRelatedChats: async (): Promise<void> => {
      await query.fetchNextPage();
    },
  };
}
