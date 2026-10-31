export const WORKFLOW_STATUS_ORDER = ["triage", "plan", "doing", "review", "done"] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUS_ORDER)[number];

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  triage: "Triage",
  plan: "Plan",
  doing: "Doing",
  review: "Review",
  done: "Done",
};

export const DEFAULT_WORKFLOW_STATUS: WorkflowStatus = "triage";
export const COMPLETED_WORKFLOW_STATUS: WorkflowStatus = "done";

export const WORKFLOW_STATUS_COLUMNS = WORKFLOW_STATUS_ORDER.map((status) => ({
  id: status,
  name: WORKFLOW_STATUS_LABELS[status],
}));

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === "string" && WORKFLOW_STATUS_ORDER.includes(value as WorkflowStatus);
}

export function getWorkflowStatusLabel(status: WorkflowStatus): string {
  return WORKFLOW_STATUS_LABELS[status];
}

export function compareWorkflowStatuses(left: WorkflowStatus, right: WorkflowStatus): number {
  return WORKFLOW_STATUS_ORDER.indexOf(left) - WORKFLOW_STATUS_ORDER.indexOf(right);
}
