import { subscribeProviderComponentReadiness } from "@/features/app-components/use-app-components";
import { getIntl } from "@/lib/i18n";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "@/components/ui/toast";
import { subscribeAgentCatalogRefresh } from "./agent-catalog-refresh";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { readableIpcError } from "./ipc-error-message";
import { queryKeys } from "./query-keys";
import { resolveRendererTransport } from "./renderer-transport";

export const agentRuntimeProvidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.agentRuntime.providers(),
    // Main owns the identity-checked catalog. Opening a picker must not force discovery.
    queryFn: () => agentRuntimeRuntime.catalog({ waitForChecks: false }),
    staleTime: 0,
  });

/** Reuse the last projection while Main refreshes it, including after Agent settings change. */
export function useAgentRuntimeProviders() {
  const client = useQueryClient();
  useEffect(() => {
    const transport = resolveRendererTransport();
    const invalidate = () => {
      void client.invalidateQueries({
        queryKey: queryKeys.agentRuntime.providers(),
        exact: true,
      });
    };
    const stopSettings = transport.subscribeAgentSettingsChanges(invalidate);
    const stopCatalog = subscribeAgentCatalogRefresh(invalidate);
    const stopReadiness = subscribeProviderComponentReadiness(invalidate);
    return () => {
      stopSettings();
      stopCatalog();
      stopReadiness();
    };
  }, [client]);
  return useQuery(agentRuntimeProvidersQueryOptions());
}

/** Asks every Agent to check its models again, and publishes what they report. */
export function useRefreshAgentRuntimeProviders() {
  const client = useQueryClient();
  return () =>
    void agentRuntimeRuntime
      .catalog({ refresh: true })
      .then((providers) => client.setQueryData(queryKeys.agentRuntime.providers(), providers))
      .catch((error: unknown) =>
        toast.danger(
          readableIpcError(
            error,
            getIntl().formatMessage({
              id: "lib.useAgentRuntimeProviders.toast.checkFailed",
              defaultMessage: "Agents could not be checked",
            }),
          ),
        ),
      );
}
