import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ClaudeUsageSnapshot } from "../../shared/agent-runtime-api";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { queryKeys } from "./query-keys";
import { resolveRendererTransport } from "./renderer-transport";

export interface ClaudeUsage {
  /** Main's snapshot; null until this window has read it. */
  readonly snapshot: ClaudeUsageSnapshot | null;
  readonly refresh: () => Promise<ClaudeUsageSnapshot>;
  readonly logout: (instanceIds: readonly string[]) => Promise<ClaudeUsageSnapshot>;
}

/**
 * Claude subscription usage as Main keeps it. Main reads it and pushes every change to every
 * window, so this window reads it once and then only follows along.
 */
export function useClaudeUsage(): ClaudeUsage {
  const client = useQueryClient();
  const queryKey = queryKeys.agentRuntime.claudeUsage();
  const query = useQuery({
    queryKey,
    queryFn: () => agentRuntimeRuntime.claudeUsage(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  useEffect(
    () =>
      resolveRendererTransport().subscribeClaudeUsageChanges?.((snapshot) =>
        client.setQueryData(queryKeys.agentRuntime.claudeUsage(), snapshot),
      ),
    [client],
  );
  const adopt = (snapshot: ClaudeUsageSnapshot) => {
    client.setQueryData(queryKey, snapshot);
    return snapshot;
  };
  return {
    snapshot: query.data ?? null,
    refresh: () => agentRuntimeRuntime.refreshClaudeUsage().then(adopt),
    logout: (instanceIds) => agentRuntimeRuntime.logoutClaude(instanceIds).then(adopt),
  };
}
