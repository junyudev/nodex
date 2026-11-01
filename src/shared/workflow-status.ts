export const WORKFLOW_STATUS_ORDER = ["triage", "plan", "doing", "review", "done"] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUS_ORDER)[number];

// Seeds new Databases and labels cross-Data-Source filters; scoped surfaces use Source option names.
export const DEFAULT_WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  triage: "Triage",
  plan: "Plan",
  doing: "Doing",
  review: "Review",
  done: "Done",
};

export const DEFAULT_WORKFLOW_STATUS: WorkflowStatus = "triage";
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
