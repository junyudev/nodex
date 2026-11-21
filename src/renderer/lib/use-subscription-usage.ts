import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { SubscriptionUsageSnapshot } from "../../shared/agent-runtime-api";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { queryKeys } from "./query-keys";
import { resolveRendererTransport } from "./renderer-transport";
import { isHostedChat } from "./hosted-chat";

export interface SubscriptionUsage {
  /** Main's snapshot; null until this window has read it. */
  readonly snapshot: SubscriptionUsageSnapshot | null;
  readonly refresh: () => Promise<SubscriptionUsageSnapshot>;
  readonly logoutClaude: (instanceIds: readonly string[]) => Promise<SubscriptionUsageSnapshot>;
}

/**
 * Runtime subscription usage as Main keeps it. Main reads it and pushes every change to every
 * personal window, so this window reads it once and then only follows along. A window whose chats
 * run on its Space host uses none of this desktop's subscription accounts, so it has no usage at all.
 */
export function useSubscriptionUsage(): SubscriptionUsage | null {
  const hosted = isHostedChat();
  const client = useQueryClient();
  const queryKey = queryKeys.agentRuntime.subscriptionUsage();
  const query = useQuery({
    queryKey,
    queryFn: () => agentRuntimeRuntime.subscriptionUsage(),
    enabled: !hosted,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  useEffect(
    () =>
      hosted
        ? undefined
        : resolveRendererTransport().subscribeSubscriptionUsageChanges?.((snapshot) =>
            client.setQueryData(queryKeys.agentRuntime.subscriptionUsage(), snapshot),
          ),
    [client, hosted],
  );
  const adopt = (snapshot: SubscriptionUsageSnapshot) => {
    client.setQueryData(queryKey, snapshot);
    return snapshot;
  };
  if (hosted) return null;
  return {
    snapshot: query.data ?? null,
    refresh: () => agentRuntimeRuntime.refreshSubscriptionUsage().then(adopt),
    logoutClaude: (instanceIds) => agentRuntimeRuntime.logoutClaude(instanceIds).then(adopt),
  };
}
