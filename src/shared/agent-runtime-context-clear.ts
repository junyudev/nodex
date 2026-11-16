import type { AgentSnapshot } from "@nodex/agent-runtime/contracts";
import { defineMessages } from "./i18n/messages";

export const CONTEXT_CLEAR_REFUSAL_MESSAGES = defineMessages({
  reply: {
    id: "shared.agentRuntimeContextClear.reply",
    defaultMessage: "Wait for the reply and queued messages to finish, then clear the context.",
  },
  background: {
    id: "shared.agentRuntimeContextClear.background",
    defaultMessage: "Stop background work before clearing the context.",
  },
  subagents: {
    id: "shared.agentRuntimeContextClear.subagents",
    defaultMessage: "Wait for subagents to report back before clearing the context.",
  },
  empty: {
    id: "shared.agentRuntimeContextClear.empty",
    defaultMessage: "Send a message before clearing the context.",
  },
});

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
  return agentRuntimeContextClearRefusalMessage(projection)?.defaultMessage ?? null;
}

export function agentRuntimeContextClearRefusalMessage(projection: Projection) {
  const messages = CONTEXT_CLEAR_REFUSAL_MESSAGES;
  if (projection.runs.some((run) => UNSETTLED_RUN_STATUSES.has(run.status))) return messages.reply;
  if (projection.providerThreads.some((thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0))
    return messages.background;
  if (projection.subagents.some((task) => ACTIVE_TASK_STATUSES.has(task.status)))
    return messages.subagents;
  if (!projection.thread?.sideChat && !projection.runs.some((run) => run.status !== "rolled_back"))
    return messages.empty;
  return null;
}
