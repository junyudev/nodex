import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { CodexHeartbeatAutomationThreadStateChangedInput } from "../../../shared/types";
import { publishCodexHeartbeatThreadState } from "../../lib/codex-automation-runtime";
import {
  acquireAgentConversationOwner,
  type AgentConversationOwnerSnapshot,
} from "./agent-conversation-owner";

export function buildNativeHeartbeatAutomationThreadState(
  threadId: string,
  state: AgentConversationOwnerSnapshot,
): CodexHeartbeatAutomationThreadStateChangedInput {
  const snapshot = state.presentation?.snapshot;
  const reason =
    state.connection !== "ready"
      ? "native_connection_unavailable"
      : !snapshot
        ? "native_snapshot_unavailable"
        : snapshot.status !== "idle"
          ? `native_${snapshot.status}`
          : state.promptPending || state.controlPending !== null
            ? "native_control_pending"
            : (snapshot.requests?.length ?? 0) > 0
              ? "waiting_on_user_input"
              : snapshot.liveBackgroundTaskIds === undefined
                ? snapshot.tasks?.some(
                    (task) =>
                      task.status === "pending" ||
                      task.status === "running" ||
                      task.status === "paused",
                  )
                  ? "native_background_task"
                  : null
                : snapshot.liveBackgroundTaskIds.length > 0
                  ? "native_background_task"
                  : null;
  return {
    threadId,
    // This is the shared native presentation owner; no Codex document writer is acquired.
    streamRole: state.connection === "ready" ? "owner" : null,
    isEligible: reason === null,
    reason,
    collaborationMode: null,
    permissions: null,
  };
}

/** Observe native readiness through its existing owner without requesting a Codex resume. */
export function NativeHeartbeatAutomationTarget({ threadId }: { readonly threadId: string }) {
  const acquired = useMemo(() => acquireAgentConversationOwner(threadId), [threadId]);
  const state = useSyncExternalStore(acquired.owner.subscribe, acquired.owner.getSnapshot);
  useEffect(() => acquired.retain(), [acquired]);
  useEffect(() => {
    const publish = () =>
      void publishCodexHeartbeatThreadState(
        buildNativeHeartbeatAutomationThreadState(threadId, acquired.owner.getSnapshot()),
      ).catch(() => undefined);
    publish();
    const interval = setInterval(publish, 30_000);
    return () => clearInterval(interval);
  }, [acquired, state, threadId]);
  useEffect(
    () => () => {
      void publishCodexHeartbeatThreadState({
        threadId,
        streamRole: null,
        isEligible: false,
        reason: "native_observer_closed",
        collaborationMode: null,
        permissions: null,
      }).catch(() => undefined);
    },
    [threadId],
  );
  return null;
}
