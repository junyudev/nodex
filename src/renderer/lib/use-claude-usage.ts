import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ClaudeUsageSnapshot } from "../../shared/agent-runtime-api";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { queryKeys } from "./query-keys";
import { resolveRendererTransport } from "./renderer-transport";
import { isHostedChat } from "./hosted-chat";

export interface ClaudeUsage {
  /** Main's snapshot; null until this window has read it. */
  readonly snapshot: ClaudeUsageSnapshot | null;
  readonly refresh: () => Promise<ClaudeUsageSnapshot>;
  readonly logout: (instanceIds: readonly string[]) => Promise<ClaudeUsageSnapshot>;
}

/**
 * Claude subscription usage as Main keeps it. Main reads it and pushes every change to every
 * personal window, so this window reads it once and then only follows along. A window whose chats
 * run on its Space host uses none of this desktop's Claude accounts, so it has no usage at all.
 */
export function useClaudeUsage(): ClaudeUsage | null {
  const hosted = isHostedChat();
  const client = useQueryClient();
  const queryKey = queryKeys.agentRuntime.claudeUsage();
  const query = useQuery({
    queryKey,
    queryFn: () => agentRuntimeRuntime.claudeUsage(),
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
        : resolveRendererTransport().subscribeClaudeUsageChanges?.((snapshot) =>
            client.setQueryData(queryKeys.agentRuntime.claudeUsage(), snapshot),
          ),
    [client, hosted],
  );
  const adopt = (snapshot: ClaudeUsageSnapshot) => {
    client.setQueryData(queryKey, snapshot);
    return snapshot;
  };
  if (hosted) return null;
  return {
    snapshot: query.data ?? null,
    refresh: () => agentRuntimeRuntime.refreshClaudeUsage().then(adopt),
    logout: (instanceIds) => agentRuntimeRuntime.logoutClaude(instanceIds).then(adopt),
  };
}
