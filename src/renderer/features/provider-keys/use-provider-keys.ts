import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { publishAgentCatalogRefresh } from "@/lib/agent-catalog-refresh";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { providerKeysRuntime, type ProviderKeysRuntime } from "@/lib/provider-keys-runtime";
import { queryKeys } from "@/lib/query-keys";
import type {
  ProviderKeyConnectInput,
  ProviderKeyResult,
  ProviderKeySettings,
  ProviderKeyUpdateInput,
} from "../../../shared/provider-keys";

/**
 * Connections change the Agents a Composer can offer, so every change reads the Agent catalog
 * again; a failed read keeps the last one, and the Composer reports what stays unusable.
 */
async function refreshAgentCatalog(client: QueryClient) {
  try {
    client.setQueryData(
      queryKeys.agentRuntime.providers(),
      await agentRuntimeRuntime.catalog({ refresh: true }),
    );
  } catch {
    // The previous catalog stays on screen.
  }
  publishAgentCatalogRefresh();
}

export interface ProviderKeysController {
  /** Null until the first read answers. */
  readonly settings: ProviderKeySettings | null;
  readonly loadError: string | null;
  readonly connect: (input: ProviderKeyConnectInput) => Promise<ProviderKeyResult>;
  readonly update: (input: ProviderKeyUpdateInput) => Promise<ProviderKeyResult>;
  readonly refreshModels: (id: string) => Promise<ProviderKeyResult>;
  readonly remove: (id: string) => Promise<void>;
}

/** The Profile's API key connections; Main owns the keys, and every window sees each change. */
export function useProviderKeys(runtime: ProviderKeysRuntime = providerKeysRuntime) {
  const client = useQueryClient();
  const queryKey = queryKeys.providerKeys();
  const query = useQuery({ queryKey, queryFn: runtime.read });
  useEffect(
    () => runtime.subscribe((settings) => client.setQueryData(queryKeys.providerKeys(), settings)),
    [client, runtime],
  );
  const settle = async (result: ProviderKeyResult) => {
    if (result.ok) {
      client.setQueryData(queryKey, result.settings);
      await refreshAgentCatalog(client);
    }
    return result;
  };
  return {
    settings: query.data ?? null,
    loadError: query.error ? String(query.error.message) : null,
    connect: async (input) => settle(await runtime.connect(input)),
    update: async (input) => settle(await runtime.update(input)),
    refreshModels: async (id) => settle(await runtime.refreshModels({ id })),
    remove: async (id) => {
      client.setQueryData(queryKey, await runtime.remove({ id }));
      await refreshAgentCatalog(client);
    },
  } satisfies ProviderKeysController;
}
