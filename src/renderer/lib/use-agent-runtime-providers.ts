import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { queryKeys } from "./query-keys";
import { resolveRendererTransport } from "./renderer-transport";

export const agentRuntimeProvidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.agentRuntime.providers(),
    // Main owns the identity-checked catalog. Opening a picker must not force discovery.
    queryFn: () => agentRuntimeRuntime.catalog(),
    staleTime: 0,
  });

/** Reuse the last projection while Main refreshes it, including after Agent settings change. */
export function useAgentRuntimeProviders() {
  const client = useQueryClient();
  useEffect(
    () =>
      resolveRendererTransport().subscribeAgentSettingsChanges(() => {
        void client.invalidateQueries({
          queryKey: queryKeys.agentRuntime.providers(),
          exact: true,
        });
      }),
    [client],
  );
  return useQuery(agentRuntimeProvidersQueryOptions());
}
