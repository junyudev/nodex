import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConversationWindowFocus } from "@/features/local-conversation/use-conversation-read-state";
import { setAutomationRunReadState } from "@/lib/automations-runtime";
import { queryKeys } from "@/lib/query-keys";
import type { AutomationRunsInboxResponse } from "@/lib/types";
import { useAutomationRunsInbox } from "@/lib/use-automation-runs";
import { applyOptimisticRunsRead } from "./automation-cache";
import { unreadRunIdsForSession } from "./automation-model";

/**
 * Marks an Automation's finished runs read while their chat is shown in a focused window. Showing
 * the chat is what reads a run, however the chat was reached: a cron run has its own chat, and
 * every beat of a heartbeat lands in the one chat it continues.
 */
export function useShownAutomationRunsRead({
  sessionId,
  shown,
}: {
  sessionId: string | null;
  shown: boolean;
}) {
  const queryClient = useQueryClient();
  const focused = useConversationWindowFocus();
  const items = useAutomationRunsInbox().data?.items;
  const unreadRunIds =
    sessionId && shown && focused && items ? unreadRunIdsForSession(items, sessionId) : [];
  const unreadRunKey = unreadRunIds.join("\n");
  // Each run is tried once, so one that cannot be updated is not retried on every refresh.
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    const runIds = unreadRunKey.split("\n").filter((id) => id && !attempted.current.has(id));
    if (runIds.length === 0) return;
    for (const runId of runIds) attempted.current.add(runId);
    const readAt = Date.now();
    const runsKey = { queryKey: queryKeys.automationRuns.all() };
    queryClient.setQueriesData<AutomationRunsInboxResponse>(runsKey, (runs) =>
      applyOptimisticRunsRead(runs, runIds, readAt),
    );
    // Read state is advisory: the refresh shows a run that failed to update as unread again.
    void Promise.allSettled(
      runIds.map((runId) => setAutomationRunReadState({ runId, readAt })),
    ).then(() => queryClient.invalidateQueries(runsKey));
  }, [unreadRunKey, queryClient]);
}
