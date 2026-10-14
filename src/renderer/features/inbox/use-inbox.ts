import { useEffect, useMemo } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  InboxCounts,
  InboxItem,
  InboxScope,
  InboxSettings,
  InboxWindowFilter,
  UpdateInboxSettingsInput,
} from "../../../shared/inbox";
import { DEFAULT_INBOX_SETTINGS, inboxScopeKey } from "../../../shared/inbox";
import { subscribeInboxChanges, subscribeLibraryChanges } from "@/lib/api";
import {
  readInboxCounts,
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

export function useInboxSummary(scope: InboxScope) {
  return useQuery({
    queryKey: queryKeys.inbox.summary(inboxScopeKey(scope)),
    queryFn: () => readInboxSummary({ scope }),
    staleTime: 5_000,
  });
}

const NO_COUNTS: InboxCounts = { library: 0, projects: {} };

/** Messages waiting in the Library Inbox and each Project's Inbox, for navigation badges. */
export function useInboxCounts(): InboxCounts {
  const query = useQuery({
    queryKey: queryKeys.inbox.counts(),
    queryFn: readInboxCounts,
    staleTime: 5_000,
  });
  return query.data ?? NO_COUNTS;
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

/** Newest-first Core windows for one Inbox view; each further page reaches older messages. */
export function useInboxStream(scope: InboxScope, filter: InboxWindowFilter) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.inbox.window(inboxScopeKey(scope), filter),
    queryFn: ({ pageParam }) =>
      readInboxWindow({ scope, filter, after: pageParam, first: INBOX_WINDOW_SIZE }),
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
