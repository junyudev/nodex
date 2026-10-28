import type { AgentRuntimeRendererTransport } from "../../lib/agent-runtime-runtime";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type {
  ConversationAgentLabelPort,
  ConversationDelegatedTaskPort,
} from "./conversation-runtime";
import { delegatedTaskAgentLabel } from "./delegated-task-presentation";
import { formatCodexModelLabel } from "../../lib/codex-thread-settings";

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
  "cancelTask" | "stopTask"
>;

/**
 * An application-owned task is cancelled the way its delegating Agent cancels it: its
 * conversation stops whatever it is doing, the tasks it delegated stop too, and its pending
 * result delivery is dropped. A provider-native task is stopped through its owning parent Run.
 */
export async function stopAgentRuntimeTask(
  sessionId: string,
  task: AgentRuntimeTaskStopTarget,
  transport: AgentRuntimeTaskStopTransport,
): Promise<void> {
  if (task.childThreadId !== null) {
    await transport.cancelTask({
      sessionId,
      threadId: task.parentThreadId,
      requestId: createUuidV7(),
      taskId: task.taskId,
    });
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
 * Profile-wide presentation facts shared by Agent Runtime conversations: configured Agent
 * labels for task rows and handoff dividers, and Stop requests that have not settled yet.
 * Rows keep showing "Stopping…" across remounts until their task reports a terminal status or
 * the request fails.
 */
export interface AgentRuntimeProviderLabel {
  readonly label: string;
  readonly kind: AgentBackendBinding["kind"];
  /** Catalog display names by model slug. */
  readonly models: ReadonlyMap<string, string>;
}

const stopKey = (sessionId: string, taskId: string) => JSON.stringify([sessionId, taskId]);

/** Reads a `readStopping` snapshot, so a render consumes the value it subscribed to. */
export function isAgentRuntimeTaskStopping(
  stopping: ReadonlySet<string>,
  sessionId: string,
  taskId: string,
): boolean {
  return stopping.has(stopKey(sessionId, taskId));
}

export function createAgentRuntimeDelegatedTaskStore() {
  let labels: ReadonlyMap<string, AgentRuntimeProviderLabel> = new Map();
  let stopping: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const key = stopKey;
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
        left.kind === right.kind &&
        left.models.size === right.models.size &&
        [...left.models].every(([slug, name]) => right.models.get(slug) === name);
      const changed = [...next].filter(
        ([instanceId, label]) => !same(label, labels.get(instanceId)),
      );
      if (changed.length === 0) return;
      labels = new Map([...labels, ...changed]);
      notify();
    },
    readLabels: () => labels,
    /** Immutable snapshot of unsettled Stop requests; it changes only when they change. */
    readStopping: () => stopping,
    isStopping: (sessionId: string, taskId: string) => stopping.has(key(sessionId, taskId)),
    markStopping: (sessionId: string, taskId: string) => {
      const entry = key(sessionId, taskId);
      if (stopping.has(entry)) return false;
      stopping = new Set([...stopping, entry]);
      notify();
      return true;
    },
    settle: (sessionId: string, taskId: string) => {
      const entry = key(sessionId, taskId);
      if (!stopping.has(entry)) return;
      stopping = new Set([...stopping].filter((candidate) => candidate !== entry));
      notify();
    },
  };
}

/** "Codex · GPT-5.5", "Claude Opus 5.5": the configured Agent and the model it runs. */
export function agentRuntimeAgentLabel(
  labels: ReadonlyMap<string, AgentRuntimeProviderLabel>,
  providerInstanceId: string,
  model: string | null,
): string | null {
  const provider = labels.get(providerInstanceId);
  return delegatedTaskAgentLabel(
    provider?.label ?? null,
    model === null ? null : (provider?.models.get(model) ?? formatCodexModelLabel(model, [])),
  );
}

export type AgentRuntimeDelegatedTaskStore = ReturnType<
  typeof createAgentRuntimeDelegatedTaskStore
>;
export const agentRuntimeDelegatedTasks = createAgentRuntimeDelegatedTaskStore();

export function createAgentRuntimeAgentLabelPort(
  store: AgentRuntimeDelegatedTaskStore,
): ConversationAgentLabelPort {
  return {
    subscribe: store.subscribe,
    label: (providerInstanceId, model) =>
      agentRuntimeAgentLabel(store.readLabels(), providerInstanceId, model),
    kind: (providerInstanceId) => store.readLabels().get(providerInstanceId)?.kind ?? null,
  };
}

export const agentRuntimeAgentLabels = createAgentRuntimeAgentLabelPort(agentRuntimeDelegatedTasks);

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
    isStopping: (taskId) => store.isStopping(sessionId, taskId),
    settle: (taskId) => store.settle(sessionId, taskId),
    stop: (parentThreadId, task) =>
      requestAgentRuntimeTaskStop(sessionId, { ...task, parentThreadId }, transport, store),
  };
}
