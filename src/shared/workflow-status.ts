import type { DatabaseViewLayout } from "./database-kernel";

export const WORKFLOW_STATUS_ORDER = [
  "triage",
  "plan",
  "doing",
  "review",
  "done",
  "canceled",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUS_ORDER)[number];

// Lists lead with active work so the next thing to do is never below Done or Canceled.
export const LIST_WORKFLOW_STATUS_ORDER = [
  "review",
  "doing",
  "plan",
  "triage",
  "done",
  "canceled",
] as const satisfies readonly WorkflowStatus[];

/** A Board reads the pipeline left to right; a List reads active work first. */
export function workflowStatusOrderForLayout(
  layout: DatabaseViewLayout,
): readonly WorkflowStatus[] {
  return layout === "list" ? LIST_WORKFLOW_STATUS_ORDER : WORKFLOW_STATUS_ORDER;
}

// Seeds new Databases and labels cross-Data-Source filters; scoped surfaces use Source option names.
export const DEFAULT_WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  triage: "Triage",
  plan: "Todo",
  doing: "In Progress",
  review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

export const DEFAULT_WORKFLOW_STATUS: WorkflowStatus = "triage";
// The destination of an explicit completion action; Canceled is terminal without acceptance.
export const COMPLETED_WORKFLOW_STATUS: WorkflowStatus = "done";

export const DEFAULT_WORKFLOW_STATUS_COLUMNS = WORKFLOW_STATUS_ORDER.map((status) => ({
  id: status,
  name: DEFAULT_WORKFLOW_STATUS_LABELS[status],
}));

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === "string" && WORKFLOW_STATUS_ORDER.includes(value as WorkflowStatus);
}

/** Resolves a Source-owned stage name, retaining unknown IDs and falling back for missing options. */
export function resolveWorkflowStatusName(
  statusId: string,
  options: readonly { readonly id: string; readonly name: string }[],
): string {
  const option = options.find((option) => option.id === statusId);
  if (option) return option.name;
  return isWorkflowStatus(statusId) ? DEFAULT_WORKFLOW_STATUS_LABELS[statusId] : statusId;
}

export function compareWorkflowStatuses(left: WorkflowStatus, right: WorkflowStatus): number {
  return WORKFLOW_STATUS_ORDER.indexOf(left) - WORKFLOW_STATUS_ORDER.indexOf(right);
}

export interface WorkflowStatusValue {
  readonly optionId: WorkflowStatus;
  readonly label: string;
}

/** Terminal stages leave active work; only Done represents acceptance. */
export function isTerminalWorkflowStatus(status: unknown): boolean {
  return status === "done" || status === "canceled";
}
