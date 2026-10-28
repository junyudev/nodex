import type { AgentSnapshot } from "@nodex/agent-runtime/contracts";

type Projection = Pick<AgentSnapshot["projection"], "runs" | "providerThreads" | "subagents"> & {
  readonly thread?: Pick<AgentSnapshot["projection"]["thread"], "sideChat">;
};

const UNSETTLED_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const ACTIVE_TASK_STATUSES = new Set(["pending", "running", "waiting"]);

/**
 * Why a chat's context cannot be cleared now, or null when it can. Clearing ends the context
 * after the latest finished Run, so it waits for every reply, queued message, background task
 * and subagent that could still add to it.
 */
export function agentRuntimeContextClearRefusal(projection: Projection): string | null {
  if (projection.runs.some((run) => UNSETTLED_RUN_STATUSES.has(run.status)))
    return "Wait for the reply and queued messages to finish, then clear the context.";
  if (projection.providerThreads.some((thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0))
    return "Stop background work before clearing the context.";
  if (projection.subagents.some((task) => ACTIVE_TASK_STATUSES.has(task.status)))
    return "Wait for subagents to report back before clearing the context.";
  if (!projection.thread?.sideChat && !projection.runs.some((run) => run.status !== "rolled_back"))
    return "Send a message before clearing the context.";
  return null;
}
