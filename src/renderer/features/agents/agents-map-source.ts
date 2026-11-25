import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  AGENTS_MAP_RECENT_WINDOW_MS,
  type AgentsMapReadInput,
  type AgentsMapScope,
  type AgentsMapSnapshot,
} from "../../../shared/agents-map";
import { useAgentRuntimeActivities } from "../../lib/agent-runtime-session-activity";
import { readAgentsMap, subscribeAgentsMapChanges } from "../../lib/agents-map-api";
import { isRemoteSpace, spaceQueryKey } from "../../lib/renderer-space";
import { sidebarRuntimeSessionPlacementsQueryOptions } from "../../lib/use-sidebar-runtime-group-activity";

export interface AgentsMapSource {
  readonly snapshot: AgentsMapSnapshot | null;
  readonly error: string | null;
  readonly retry: () => void;
}

const mapKey = (projectId: string | null, recentLimit: number) =>
  spaceQueryKey(["agents-map", projectId, recentLimit] as const);

/** The chats in scope with their work trees, kept current while `enabled`. */
export function useAgentsMap({
  scope: { projectId },
  recentLimit,
  enabled,
}: AgentsMapReadInput & { readonly enabled: boolean }): AgentsMapSource {
  const client = useQueryClient();
  const hosted = isRemoteSpace();
  const query = useQuery({
    queryKey: mapKey(projectId, recentLimit),
    queryFn: () => readAgentsMap({ scope: { projectId }, recentLimit }),
    enabled,
    retry: false,
    placeholderData: (previous) => (previous?.scope.projectId === projectId ? previous : undefined),
    // Recent rows also expire in a quiet Space. Schedule only while there are rows to expire.
    refetchInterval: ({ state }) => {
      const settledAt = state.data?.recent.at(-1)?.settledAt;
      const expiry = settledAt
        ? Math.max(1_000, Date.parse(settledAt) + AGENTS_MAP_RECENT_WINDOW_MS - Date.now())
        : Infinity;
      // Hosted chat observation follows Core changes and periodically repairs Runtime-only changes.
      return hosted && state.status === "success" ? Math.min(15_000, expiry) : false;
    },
  });
  useEffect(() => {
    if (!enabled) return;
    const queryKey = mapKey(projectId, recentLimit);
    let following = true;
    let latest = -1;
    let refreshing = false;
    let dirty = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      while (dirty) {
        dirty = false;
        const requested = latest;
        // Share any in-flight read. If it started before a push, re-read after it settles.
        await client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
        if (!following) break;
        const state = client.getQueryState<AgentsMapSnapshot>(queryKey);
        if (state?.status === "success" && state.data && state.data.revision < requested)
          dirty = true;
      }
      refreshing = false;
    };
    const unsubscribe = subscribeAgentsMapChanges((revision) => {
      dirty = true;
      latest = Math.max(latest, revision ?? -1);
      void refresh();
    });
    return () => {
      following = false;
      unsubscribe?.();
    };
  }, [client, enabled, projectId, recentLimit]);
  return {
    snapshot: query.data ?? null,
    error: query.error?.message ?? null,
    retry: () => {
      if (enabled) void query.refetch();
    },
  };
}

/** Whether any in-scope chat awaits its person, else whether any has live work. */
export function useAgentsMapPulse({ projectId }: AgentsMapScope): "waiting" | "working" | "idle" {
  const activities = useAgentRuntimeActivities();
  const placements = useQuery(sidebarRuntimeSessionPlacementsQueryOptions(activities.keys()));
  let working = false;
  for (const placement of placements.data ?? []) {
    if (placement.hidden || (projectId !== null && placement.projectId !== projectId)) continue;
    const activity = activities.get(placement.sessionId);
    if (!activity || activity.sideChatSourceThreadId) continue;
    if (activity.status === "waiting") return "waiting";
    working = true;
  }
  return working ? "working" : "idle";
}
