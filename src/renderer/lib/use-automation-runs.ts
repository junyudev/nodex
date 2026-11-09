import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { subscribeAutomationRunsUpdates, subscribeAutomationChanges } from "./api";
import { automationRunsInboxQueryOptions } from "./query-options";
import { queryKeys } from "./query-keys";

export function useAutomationRunsInbox(limit = 200) {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...automationRunsInboxQueryOptions(limit),
    enabled: electronAvailable,
  });

  useEffect(() => {
    if (!electronAvailable) return;
    return subscribeAutomationChanges(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.automationRuns.inbox(limit),
      });
    });
  }, [electronAvailable, limit, queryClient]);

  useEffect(() => {
    if (!electronAvailable) return;
    return subscribeAutomationRunsUpdates(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.automationRuns.all(),
      });
    });
  }, [electronAvailable, queryClient]);

  return query;
}
