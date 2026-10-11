import { useEffect, useMemo } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  InboxItem,
  InboxSettings,
  InboxWindowFilter,
  UpdateInboxSettingsInput,
} from "../../../shared/inbox";
import { DEFAULT_INBOX_SETTINGS } from "../../../shared/inbox";
import { subscribeInboxChanges, subscribeLibraryChanges } from "@/lib/api";
import {
  readInboxSettings,
  readInboxSummary,
  readInboxWindow,
  updateInboxSettings,
} from "@/lib/inbox-runtime";
import { queryKeys } from "@/lib/query-keys";

const INBOX_WINDOW_SIZE = 50;

export const invalidateInbox = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: queryKeys.inbox.all() });

/** Inbox truth changes through Core events, chat activity, and edits to message Pages. */
export function useInboxInvalidation(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const invalidate = () => void invalidateInbox(queryClient);
    const unsubscribeInbox = subscribeInboxChanges(invalidate);
    const unsubscribeLibrary = subscribeLibraryChanges(invalidate);
    return () => {
      unsubscribeInbox();
      unsubscribeLibrary();
    };
  }, [queryClient]);
}

export function useInboxSummary() {
  return useQuery({
    queryKey: queryKeys.inbox.summary(),
    queryFn: readInboxSummary,
    staleTime: 5_000,
  });
}

export function useInboxSettings(): InboxSettings {
  const query = useQuery({
    queryKey: queryKeys.inbox.settings(),
    queryFn: readInboxSettings,
    staleTime: 30_000,
  });
  return query.data ?? DEFAULT_INBOX_SETTINGS;
}

export function useUpdateInboxSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateInboxSettingsInput) => updateInboxSettings(input),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.inbox.settings(), settings);
    },
  });
}

/** Newest-first Core windows for one view; each further page reaches older messages. */
export function useInboxStream(filter: InboxWindowFilter) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.inbox.window(filter),
    queryFn: ({ pageParam }) =>
      readInboxWindow({ filter, after: pageParam, first: INBOX_WINDOW_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 2_000,
  });
  const items = useMemo<readonly InboxItem[]>(
    () => (query.data?.pages ?? []).flatMap((page) => page.items),
    [query.data],
  );
  return {
    items,
    isPending: query.isPending,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
  };
}
