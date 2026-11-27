import { skipToken, useQuery } from "@tanstack/react-query";
import { readSessionFollowUps } from "@/lib/inbox-runtime";
import { queryKeys } from "@/lib/query-keys";

/** The Inbox messages a chat's Agents left, live with every Inbox change; null reads nothing. */
export function useSessionFollowUps(sessionId: string | null) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.inbox.sessionFollowUps(sessionId),
    queryFn: sessionId === null ? skipToken : () => readSessionFollowUps({ sessionId }),
    staleTime: 2_000,
  });
  return { data, isLoading, error };
}
