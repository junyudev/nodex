import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";
import type { ThreadExecutionLocationView } from "../../shared/codex-thread-handoff";
import {
  useAgentRuntimeConnectionState,
  useAgentRuntimeSessionActivity,
  type AgentRuntimeActivityStore,
} from "./agent-runtime-session-activity";
import { queryKeys } from "./query-keys";
import { readThreadExecutionLocation } from "./thread-handoff-runtime";

export function threadExecutionLocationQueryOptions(threadId: string) {
  return queryOptions({
    queryKey: queryKeys.threadExecution.location(threadId),
    queryFn: () => readThreadExecutionLocation(threadId),
    // Location changes only through a move; completed moves and finished Runs invalidate it.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export type RuntimeLocationReadPolicy =
  /** Explicit surfaces such as the open chat or a context menu may start the Runtime. */
  | "on-demand"
  /** Passive rows read only from a running Runtime and otherwise show the cached location. */
  | "when-runtime-ready";

/** Cached canonical location of a Runtime root; null until known. */
export function useRuntimeExecutionLocation(
  rootThreadId: string | null,
  policy: RuntimeLocationReadPolicy,
  store?: AgentRuntimeActivityStore,
): ThreadExecutionLocationView | null {
  const connection = useAgentRuntimeConnectionState(store);
  const enabled =
    rootThreadId !== null && (policy === "on-demand" || connection.status === "ready");
  const query = useQuery({ ...threadExecutionLocationQueryOptions(rootThreadId ?? ""), enabled });
  return rootThreadId ? (query.data ?? null) : null;
}

/**
 * Leaf state for one Runtime Session row: its live activity and cached location. A Run that
 * finishes may have moved the Session, so its location is re-read once it becomes idle.
 */
export function useRuntimeSessionLiveState(
  runtime: { readonly sessionId: string; readonly rootThreadId: string } | null,
  store?: AgentRuntimeActivityStore,
): {
  readonly activity: AgentRuntimeSessionActivity | null;
  readonly location: ThreadExecutionLocationView | null;
} {
  const activity = useAgentRuntimeSessionActivity(runtime?.sessionId, store);
  const location = useRuntimeExecutionLocation(
    runtime?.rootThreadId ?? null,
    "when-runtime-ready",
    store,
  );
  useInvalidateLocationAfterActivity(runtime?.rootThreadId ?? null, activity !== null);
  return { activity, location };
}

function useInvalidateLocationAfterActivity(rootThreadId: string | null, live: boolean) {
  const queryClient = useQueryClient();
  const wasLive = useRef(live);
  useEffect(() => {
    const finished = wasLive.current && !live;
    wasLive.current = live;
    if (!finished || !rootThreadId) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.threadExecution.location(rootThreadId),
      exact: true,
    });
  }, [live, queryClient, rootThreadId]);
}
