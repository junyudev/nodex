import { useSyncExternalStore } from "react";
import {
  agentRuntimeRuntime,
  type AgentRuntimeRendererTransport,
} from "../../lib/agent-runtime-runtime";
import { useAgentRuntimeSessionActivity } from "../../lib/agent-runtime-session-activity";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type { AgentRuntimeSessionActivity } from "../../../shared/agent-runtime-api";
import {
  agentRuntimeDelegatedTasks,
  isAgentRuntimeTaskStopping,
  type AgentRuntimeDelegatedTaskStore,
} from "./agent-runtime-delegated-tasks";
import type { ConversationBackgroundTask, ConversationBackgroundTasks } from "./thread-stage-types";

type ActivityTask = AgentRuntimeSessionActivity["backgroundTasks"][number];

const UNNAMED: Record<ConversationBackgroundTask["kind"], string> = {
  command: "Background command",
  monitor: "Monitor",
  task: "Background task",
};

/**
 * A Stop the Runtime accepted ends the task through the Agent, which removes it from the list.
 * One that is still listed after this long can be stopped again.
 */
export const BACKGROUND_STOP_SETTLE_MS = 15_000;

/**
 * The Session's live background work: the same facts that keep its chat working in the
 * sidebar, including work its delegated conversations left running.
 */
export function projectAgentRuntimeBackgroundTasks(
  tasks: readonly ActivityTask[],
  isStopping: (taskId: string) => boolean,
): readonly ConversationBackgroundTask[] {
  return tasks.map((task) => {
    const kind = task.kind === "background_task" ? "task" : task.kind;
    const startedAtMs = task.startedAt === null ? NaN : Date.parse(task.startedAt);
    return {
      id: task.taskId,
      kind,
      label: task.description ?? task.command ?? UNNAMED[kind],
      command: task.command,
      owner: task.threadTitle,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
      stopping: isStopping(task.taskId),
    };
  });
}

export type AgentRuntimeBackgroundTransport = Pick<
  AgentRuntimeRendererTransport,
  "stopBackground" | "backgroundOutput"
>;

/**
 * Stop marks the requested tasks at once and asks each owning conversation to end them. A
 * rejected request releases its tasks; an accepted one leaves them marked until the Agent
 * ends them or the settle window passes.
 */
export async function requestAgentRuntimeBackgroundStop(
  sessionId: string,
  tasks: readonly Pick<ActivityTask, "threadId" | "taskId">[],
  transport: AgentRuntimeBackgroundTransport,
  store: AgentRuntimeDelegatedTaskStore = agentRuntimeDelegatedTasks,
): Promise<void> {
  const byThread = new Map<string, string[]>();
  for (const task of tasks) {
    if (!store.markStopping(sessionId, task.taskId)) continue;
    byThread.set(task.threadId, [...(byThread.get(task.threadId) ?? []), task.taskId]);
  }
  const results = await Promise.allSettled(
    [...byThread].map(async ([threadId, taskIds]) => {
      const release = () => {
        for (const taskId of taskIds) store.settle(sessionId, taskId);
      };
      try {
        await transport.stopBackground({
          sessionId,
          threadId,
          requestId: createUuidV7(),
          taskIds,
        });
      } catch (cause) {
        release();
        throw cause;
      }
      setTimeout(release, BACKGROUND_STOP_SETTLE_MS);
    }),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

export function createAgentRuntimeBackgroundTasks(
  sessionId: string,
  activityTasks: readonly ActivityTask[],
  tasks: readonly ConversationBackgroundTask[],
  transport: AgentRuntimeBackgroundTransport,
  store: AgentRuntimeDelegatedTaskStore = agentRuntimeDelegatedTasks,
): ConversationBackgroundTasks {
  const stopping = new Set(tasks.filter((task) => task.stopping).map((task) => task.id));
  const live = activityTasks.filter((task) => !stopping.has(task.taskId));
  return {
    tasks,
    stop: (taskId) =>
      requestAgentRuntimeBackgroundStop(
        sessionId,
        taskId === undefined ? live : activityTasks.filter((task) => task.taskId === taskId),
        transport,
        store,
      ),
    readOutput: async (taskId) => {
      const task = activityTasks.find((candidate) => candidate.taskId === taskId);
      if (!task) return null;
      const output = await transport.backgroundOutput({
        sessionId,
        threadId: task.threadId,
        taskId,
      });
      return output && { text: output.text, truncated: output.truncated };
    },
  };
}

/** A Session root's background work, or null while it has none. */
export function useAgentRuntimeBackgroundTasks(
  sessionId: string | null,
): ConversationBackgroundTasks | null {
  const activity = useAgentRuntimeSessionActivity(sessionId);
  const stopping = useSyncExternalStore(
    agentRuntimeDelegatedTasks.subscribe,
    agentRuntimeDelegatedTasks.readStopping,
  );
  const activityTasks = activity?.backgroundTasks ?? [];
  if (!sessionId || activityTasks.length === 0) return null;
  const tasks = projectAgentRuntimeBackgroundTasks(activityTasks, (taskId) =>
    isAgentRuntimeTaskStopping(stopping, sessionId, taskId),
  );
  return createAgentRuntimeBackgroundTasks(sessionId, activityTasks, tasks, agentRuntimeRuntime);
}
