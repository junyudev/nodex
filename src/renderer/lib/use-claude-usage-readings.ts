import { hashKey, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent } from "react";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import {
  agentRuntimeActivityStore,
  type AgentRuntimeActivityStore,
} from "./agent-runtime-session-activity";
import { queryKeys } from "./query-keys";
import { resolveRendererTransport } from "./renderer-transport";
import { claudeUsageReadings, type UsageReading } from "./usage-meter";

type Providers = AgentRuntimeOperations["providers.read"]["output"];

/**
 * Reads only what Nodex already knows about its Agents. It never starts execution, never asks a
 * provider for usage and never refetches on its own: the events below decide when to look again.
 */
export const knownAgentProvidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.agentRuntime.knownProviders(),
    queryFn: () => agentRuntimeRuntime.knownCatalog(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

function runningSessions(
  activities: ReadonlyMap<string, AgentRuntimeSessionActivity>,
): ReadonlyMap<string, string> {
  const running = new Map<string, string>();
  for (const [sessionId, activity] of activities)
    if (activity.status === "running") running.set(sessionId, activity.providerInstanceId);
  return running;
}

/**
 * Claude's subscription usage, one reading per account. Nothing here polls. The reading is taken
 * again when Agent settings change, and taken over whenever another surface reads the live
 * provider catalog. While a Claude meter is showing, a settled Claude reply (when Claude reports
 * usage) and execution becoming available also take it again.
 */
export function useClaudeUsageReadings(
  store: AgentRuntimeActivityStore = agentRuntimeActivityStore,
): readonly UsageReading[] {
  const client = useQueryClient();
  const query = useQuery(knownAgentProvidersQueryOptions());
  const providers = query.data ?? null;
  const readings = claudeUsageReadings(providers);
  const watching = readings.length > 0;
  const reread = useEffectEvent(() => {
    void client.invalidateQueries({
      queryKey: queryKeys.agentRuntime.knownProviders(),
      exact: true,
    });
  });
  const isClaudeInstance = useEffectEvent((instanceId: string) =>
    (providers ?? []).some(
      (provider) => provider.instanceId === instanceId && provider.driver === "claudeAgent",
    ),
  );

  useEffect(() => resolveRendererTransport().subscribeAgentSettingsChanges(reread), []);
  // A live catalog read by a model picker or launch carries the same usage; reuse it.
  useEffect(() => {
    const catalogKey = hashKey(queryKeys.agentRuntime.providers());
    return client.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "success" &&
        event.query.queryHash === catalogKey
      )
        client.setQueryData(
          queryKeys.agentRuntime.knownProviders(),
          event.query.state.data as Providers,
        );
    });
  }, [client]);
  useEffect(() => {
    if (!watching) return;
    let running = runningSessions(store.readAll());
    let ready = store.readConnection().status === "ready";
    const stopActivity = store.subscribeAll(() => {
      const next = runningSessions(store.readAll());
      const settledClaude = [...running].some(
        ([sessionId, instanceId]) => !next.has(sessionId) && isClaudeInstance(instanceId),
      );
      running = next;
      if (settledClaude) reread();
    });
    const stopConnection = store.subscribeConnection(() => {
      const nowReady = store.readConnection().status === "ready";
      if (nowReady && !ready) reread();
      ready = nowReady;
    });
    return () => {
      stopActivity();
      stopConnection();
    };
  }, [store, watching]);

  return readings;
}
