import type {
  CodexDelegatedTaskStatus,
  CodexDelegatedTaskView,
  CodexRuntimeNotice,
} from "../../../shared/types";

/** The row additionally shows a Stop request that the task has not settled yet. */
export type DelegatedTaskRowStatus = CodexDelegatedTaskStatus | "stopping";

export const isDelegatedTaskLive = (status: CodexDelegatedTaskStatus): boolean =>
  status === "running" || status === "waiting";

export function resolveDelegatedTaskRowStatus(
  status: CodexDelegatedTaskStatus,
  stopRequested: boolean,
): DelegatedTaskRowStatus {
  return stopRequested && isDelegatedTaskLive(status) ? "stopping" : status;
}

const STATUS_LABEL: Record<DelegatedTaskRowStatus, string> = {
  running: "Running",
  waiting: "Waiting",
  stopping: "Stopping…",
  stopped: "Stopped",
  cancelled: "Cancelled",
  failed: "Failed",
  completed: "Done",
};

export const delegatedTaskStatusLabel = (status: DelegatedTaskRowStatus): string =>
  STATUS_LABEL[status];

/**
 * Provider and model identify who runs the task. A model name that already starts with
 * its provider's label stands alone; unknown parts are omitted.
 */
export function delegatedTaskAgentLabel(
  providerLabel: string | null,
  modelLabel: string | null,
): string | null {
  const provider = providerLabel?.trim() || null;
  const model = modelLabel?.trim() || null;
  if (provider && model)
    return model.toLowerCase().startsWith(provider.toLowerCase())
      ? model
      : `${provider} · ${model}`;
  return provider ?? model;
}

/** Only an open task can be stopped, and only through its exact owning Run. */
export const canStopDelegatedTask = (task: CodexDelegatedTaskView): boolean =>
  isDelegatedTaskLive(task.status) && task.ownerRunId !== null;

/** Markdown export mirrors the row: title, who ran it and how it ended. */
export function delegatedTaskMarkdownLines(
  task: CodexDelegatedTaskView,
): readonly (string | null)[] {
  return [
    task.title,
    `Status: ${delegatedTaskStatusLabel(task.status)}`,
    task.summary ? `Result: ${task.summary}` : null,
  ];
}

export type RuntimeNoticeTone = "neutral" | "danger";

export const runtimeNoticeTone = (notice: CodexRuntimeNotice | undefined): RuntimeNoticeTone =>
  notice?.kind === "report" && notice.outcome === "failed" ? "danger" : "neutral";
