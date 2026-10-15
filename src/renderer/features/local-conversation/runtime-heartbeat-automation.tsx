import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CodexHeartbeatAutomationThreadStateChangedInput } from "../../../shared/types";
import { publishCodexHeartbeatThreadState } from "../../lib/codex-automation-runtime";
import { projectSessionDetailQueryOptions } from "../../lib/query-options";
import {
  acquireAgentRuntimeConversationOwner,
  type AgentRuntimeConversationOwnerSnapshot,
} from "./agent-runtime-conversation-owner";

const liveStatuses = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
  "pending",
  "paused",
]);
export function buildRuntimeHeartbeatAutomationSessionState(
  sessionId: string,
  state: AgentRuntimeConversationOwnerSnapshot,
): CodexHeartbeatAutomationThreadStateChangedInput {
  const reason = unavailableReason(state);
  return {
    sessionId,
    streamRole: state.connection === "ready" ? "owner" : null,
    isEligible: reason === null,
    reason,
    collaborationMode: null,
  };
}

function unavailableReason(state: AgentRuntimeConversationOwnerSnapshot): string | null {
  if (state.connection !== "ready") return "execution_connection_unavailable";
  const projection = state.conversation?.snapshot.projection;
  if (!projection) return "execution_metadata_unavailable";
  if (projection.thread.deletedAt || projection.thread.archivedAt) return "session_inactive";
  if (projection.runtimeRequests.some((request) => request.status === "pending"))
    return "waiting_on_user_input";
  if (projection.runs.some((run) => liveStatuses.has(run.status))) return "run_in_progress";
  if (projection.subagents.some((task) => liveStatuses.has(task.status))) return "background_task";
  if (projection.providerThreads.some((thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0))
    return "background_task";
  return null;
}

function RuntimeHeartbeatExecutionTarget({
  sessionId,
  threadId,
}: {
  readonly sessionId: string;
  readonly threadId: string;
}) {
  const acquired = useMemo(
    () => acquireAgentRuntimeConversationOwner({ sessionId, threadId }),
    [sessionId, threadId],
  );
  const state = useSyncExternalStore(acquired.owner.subscribe, acquired.owner.getSnapshot);
  useEffect(() => acquired.retain(), [acquired]);
  useEffect(() => {
    void publishCodexHeartbeatThreadState(
      buildRuntimeHeartbeatAutomationSessionState(sessionId, state),
    ).catch(() => undefined);
  }, [sessionId, state]);
  useEffect(() => {
    const interval = setInterval(() => {
      void acquired.owner
        .resume()
        .then(() =>
          publishCodexHeartbeatThreadState(
            buildRuntimeHeartbeatAutomationSessionState(sessionId, acquired.owner.getSnapshot()),
          ),
        )
        .catch(() => undefined);
    }, 30_000);
    return () => {
      clearInterval(interval);
      void publishCodexHeartbeatThreadState({
        sessionId,
        streamRole: null,
        isEligible: false,
        reason: "execution_observer_closed",
      }).catch(() => undefined);
    };
  }, [acquired, sessionId]);
  return null;
}

export function RuntimeHeartbeatAutomationTarget({ sessionId }: { readonly sessionId: string }) {
  const session = useQuery(projectSessionDetailQueryOptions(sessionId));
  const threadId = session.data?.archived ? null : session.data?.executionRef?.threadId;
  useEffect(() => {
    if (threadId) return;
    void publishCodexHeartbeatThreadState({
      sessionId,
      streamRole: null,
      isEligible: false,
      reason: "session_execution_unavailable",
    }).catch(() => undefined);
  }, [sessionId, threadId]);
  if (!threadId) return null;
  return <RuntimeHeartbeatExecutionTarget sessionId={sessionId} threadId={threadId} />;
}
