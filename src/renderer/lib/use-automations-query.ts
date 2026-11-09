import { isRemoteSpace } from "./renderer-space";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { subscribeAutomationRunsUpdates, subscribeAutomationChanges } from "./api";
import { automationsListQueryOptions } from "./query-options";
import { queryKeys } from "./query-keys";

export function useAutomationsQuery() {
  const queryClient = useQueryClient();
  const electronAvailable =
    typeof window !== "undefined" && Boolean(window.api) && !isRemoteSpace();
  const query = useQuery({
    ...automationsListQueryOptions(),
    enabled: electronAvailable,
  });

  useEffect(() => {
    if (!electronAvailable) return;
    return subscribeAutomationChanges(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.automations.all(),
      });
    });
  }, [electronAvailable, queryClient]);

  useEffect(() => {
    if (!electronAvailable) return;
    return subscribeAutomationRunsUpdates(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.automations.all(),
      });
    });
  }, [electronAvailable, queryClient]);

  return query;
}
