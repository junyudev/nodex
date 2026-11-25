import type { AgentSubagentOverview } from "@nodex/agent-runtime/contracts";
import { useEffect, useSyncExternalStore } from "react";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { useRunStopCapabilities } from "@/lib/use-chat-capabilities";
import type { CodexSubagentOverviewRow } from "../../../shared/types";
import {
  agentRuntimeDelegatedTasks,
  isAgentRuntimeTaskStopping,
  requestAgentRuntimeTaskStop,
} from "./agent-runtime-delegated-tasks";
import { findAgentRuntimeOverviewSubagent } from "./agent-runtime-subagent-overview";

/**
 * Stop for the subagents a chat's overview shows. Stop addresses a subagent's current turn,
 * which stops the subagent, and each subagent answers for the Run that owns that turn.
 */
export function useAgentRuntimeSubagentStop(
  sessionId: string,
  source: AgentSubagentOverview | null,
  onError: (cause: unknown) => void,
) {
  const canStopRun = useRunStopCapabilities(
    sessionId,
    source?.active.items.map((subagent) => subagent.runId) ?? [],
  );
  const stopping = useSyncExternalStore(
    agentRuntimeDelegatedTasks.subscribe,
    agentRuntimeDelegatedTasks.readStopping,
  );
  // A settled turn ends its Stop request.
  useEffect(() => {
    for (const subagent of source?.terminal.items ?? [])
      agentRuntimeDelegatedTasks.settle(sessionId, subagent.taskId);
  }, [sessionId, source]);
  const liveSubagent = (row: CodexSubagentOverviewRow) => {
    if (!source) return undefined;
    const subagent = findAgentRuntimeOverviewSubagent(source, row);
    return subagent && source.active.items.includes(subagent) ? subagent : undefined;
  };
  return {
    canStopRun,
    isStopping: (row: CodexSubagentOverviewRow) => {
      const subagent = liveSubagent(row);
      return (
        subagent !== undefined && isAgentRuntimeTaskStopping(stopping, sessionId, subagent.taskId)
      );
    },
    /** A row offers Stop only where its own `canStop` says this reader may. */
    stop: (row: CodexSubagentOverviewRow) => {
      const subagent = liveSubagent(row);
      if (!subagent) return;
      void requestAgentRuntimeTaskStop(
        sessionId,
        {
          taskId: subagent.taskId,
          parentThreadId: subagent.threadId,
          ownerRunId: subagent.runId,
          childThreadId: subagent.childThreadId,
        },
        agentRuntimeRuntime,
      ).catch(onError);
    },
  };
}
