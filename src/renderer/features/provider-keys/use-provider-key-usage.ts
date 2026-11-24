import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { isHostedChat } from "@/lib/hosted-chat";
import { providerKeyUsageRuntime } from "@/lib/provider-keys-runtime";
import { queryKeys } from "@/lib/query-keys";
import type { ProviderKeyUsageSnapshot } from "../../../shared/provider-key-usage";

export interface ProviderKeyUsage {
  readonly snapshot: ProviderKeyUsageSnapshot | null;
  readonly refresh: (connectionId?: string) => Promise<ProviderKeyUsageSnapshot>;
}

/** Read Main's current usage once and keep the window's query cache up to date with Main's pushes. */
export function useProviderKeyUsage(): ProviderKeyUsage | null {
  const hosted = isHostedChat();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.providerKeyUsage(),
    queryFn: providerKeyUsageRuntime.read,
    enabled: false,
  });

  useEffect(() => {
    if (hosted) return;
    const queryKey = queryKeys.providerKeyUsage();
    const unsubscribe = providerKeyUsageRuntime.subscribe((snapshot) => {
      // An initial read may still be in flight when Main sends a newer snapshot.
      void client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, snapshot);
    });
    // Subscribe before reading so a change cannot fall between the read and the listener.
    void client
      .fetchQuery({
        queryKey,
        queryFn: providerKeyUsageRuntime.read,
        retry: false,
      })
      .catch(() => undefined);
    return unsubscribe;
  }, [client, hosted]);

  if (hosted) return null;
  return { snapshot: query.data ?? null, refresh: providerKeyUsageRuntime.refresh };
}
