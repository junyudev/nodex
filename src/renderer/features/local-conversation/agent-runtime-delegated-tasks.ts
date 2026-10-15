import type { AgentRuntimeRendererTransport } from "../../lib/agent-runtime-runtime";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type { ConversationDelegatedTaskPort } from "./conversation-runtime";

/** The identities needed to stop one delegated task through its real execution owner. */
export interface AgentRuntimeTaskStopTarget {
  readonly taskId: string;
  /** The parent conversation that owns the task. */
  readonly parentThreadId: string;
  readonly ownerRunId: string | null;
  /** An application-owned child conversation; provider-native observations have none. */
  readonly childThreadId: string | null;
}

export type AgentRuntimeTaskStopTransport = Pick<
  AgentRuntimeRendererTransport,
  "inspect" | "stop" | "stopTask"
>;

/**
 * An application-owned task runs in its own conversation, so Stop interrupts that
 * conversation's active Run; the Runtime then settles the task as stopped and drops its
 * pending result delivery. A provider-native task is stopped through its owning parent Run.
 */
export async function stopAgentRuntimeTask(
  sessionId: string,
  task: AgentRuntimeTaskStopTarget,
  transport: AgentRuntimeTaskStopTransport,
): Promise<void> {
  if (task.childThreadId !== null) {
    const child = await transport.inspect({ sessionId, threadId: task.childThreadId });
    const runId = child.thread.activeRunId;
    if (runId === null) throw new Error("This subagent has no running turn to stop");
    await transport.stop({ sessionId, threadId: task.childThreadId, runId });
    return;
  }
  if (task.ownerRunId === null) throw new Error("This subagent can no longer be stopped");
  await transport.stopTask({
    sessionId,
    threadId: task.parentThreadId,
    requestId: createUuidV7(),
    runId: task.ownerRunId,
    taskId: task.taskId,
  });
}

/**
 * Profile-wide presentation facts shared by every delegated task row: configured Agent
 * labels and Stop requests that have not settled yet. Rows keep showing "Stopping…" across
 * remounts until their task reports a terminal status or the request fails.
 */
export interface AgentRuntimeProviderLabel {
  readonly label: string;
  /** Catalog display names by model slug. */
  readonly models: ReadonlyMap<string, string>;
}

export function createAgentRuntimeDelegatedTaskStore() {
  let labels: ReadonlyMap<string, AgentRuntimeProviderLabel> = new Map();
  const stopping = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const key = (sessionId: string, taskId: string) => JSON.stringify([sessionId, taskId]);
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Upserts the catalog an adapter loaded; a still-loading adapter cannot erase labels. */
    publishLabels: (next: ReadonlyMap<string, AgentRuntimeProviderLabel>) => {
      const same = (
        left: AgentRuntimeProviderLabel,
        right: AgentRuntimeProviderLabel | undefined,
      ) =>
        right !== undefined &&
        left.label === right.label &&
        left.models.size === right.models.size &&
        [...left.models].every(([slug, name]) => right.models.get(slug) === name);
      const changed = [...next].filter(
        ([instanceId, label]) => !same(label, labels.get(instanceId)),
      );
      if (changed.length === 0) return;
      labels = new Map([...labels, ...changed]);
      notify();
    },
    providerLabel: (providerInstanceId: string) => labels.get(providerInstanceId)?.label ?? null,
    modelLabel: (providerInstanceId: string, model: string) =>
      labels.get(providerInstanceId)?.models.get(model) ?? null,
    isStopping: (sessionId: string, taskId: string) => stopping.has(key(sessionId, taskId)),
    markStopping: (sessionId: string, taskId: string) => {
      const entry = key(sessionId, taskId);
      if (stopping.has(entry)) return false;
      stopping.add(entry);
      notify();
      return true;
    },
    settle: (sessionId: string, taskId: string) => {
      if (stopping.delete(key(sessionId, taskId))) notify();
    },
  };
}

export type AgentRuntimeDelegatedTaskStore = ReturnType<
  typeof createAgentRuntimeDelegatedTaskStore
>;
export const agentRuntimeDelegatedTasks = createAgentRuntimeDelegatedTaskStore();

/** Stop marks the task immediately and keeps the mark until it settles or the request fails. */
export async function requestAgentRuntimeTaskStop(
  sessionId: string,
  task: AgentRuntimeTaskStopTarget,
  transport: AgentRuntimeTaskStopTransport,
  store: AgentRuntimeDelegatedTaskStore = agentRuntimeDelegatedTasks,
): Promise<void> {
  if (!store.markStopping(sessionId, task.taskId)) return;
  try {
    await stopAgentRuntimeTask(sessionId, task, transport);
  } catch (cause) {
    store.settle(sessionId, task.taskId);
    throw cause;
  }
}

export function createAgentRuntimeDelegatedTaskPort(
  sessionId: string,
  transport: AgentRuntimeTaskStopTransport,
  store: AgentRuntimeDelegatedTaskStore = agentRuntimeDelegatedTasks,
): ConversationDelegatedTaskPort {
  return {
    subscribe: store.subscribe,
    providerLabel: store.providerLabel,
    modelLabel: store.modelLabel,
    isStopping: (taskId) => store.isStopping(sessionId, taskId),
    settle: (taskId) => store.settle(sessionId, taskId),
    stop: (parentThreadId, task) =>
      requestAgentRuntimeTaskStop(sessionId, { ...task, parentThreadId }, transport, store),
  };
}
