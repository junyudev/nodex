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

const SUMMARY_STATUS_ORDER: readonly DelegatedTaskRowStatus[] = [
  "failed",
  "stopping",
  "waiting",
  "running",
  "cancelled",
  "stopped",
  "completed",
];

/** A mixed group keeps every outcome visible instead of projecting a false shared lifecycle. */
export function delegatedTaskGroupStatusLabel(statuses: readonly DelegatedTaskRowStatus[]): string {
  const first = statuses[0];
  if (first === undefined) return "";
  const are = statuses.length === 1 ? "is" : "are";
  if (statuses.every((status) => status === first)) {
    switch (first) {
      case "running":
        return `${are} working`;
      case "waiting":
        return `${are} waiting`;
      case "stopping":
        return `${are} stopping…`;
      case "completed":
        return "finished";
      case "cancelled":
        return statuses.length === 1 ? "was cancelled" : "were cancelled";
      case "stopped":
      case "failed":
        return first;
    }
  }
  const counts = new Map<DelegatedTaskRowStatus, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return `— ${SUMMARY_STATUS_ORDER.flatMap((status) => {
    const count = counts.get(status);
    if (count === undefined) return [];
    const label = status === "running" ? "working" : delegatedTaskStatusLabel(status).toLowerCase();
    return [`${count} ${label}`];
  }).join(" · ")}`;
}

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
