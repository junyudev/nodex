import { isWorkflowStatus, type WorkflowStatus } from "./workflow-status";

export const LEGACY_WORKFLOW_STATUS_ORDER = [
  "draft",
  "backlog",
  "in_progress",
  "in_review",
  "done",
] as const;

export type LegacyWorkflowStatus = (typeof LEGACY_WORKFLOW_STATUS_ORDER)[number];

export const WORKFLOW_STATUS_CUTOVER_MAP: Readonly<Record<LegacyWorkflowStatus, WorkflowStatus>> = {
  draft: "triage",
  backlog: "plan",
  in_progress: "doing",
  in_review: "review",
  done: "done",
};

export function isLegacyWorkflowStatus(value: unknown): value is LegacyWorkflowStatus {
  return (
    typeof value === "string" &&
    LEGACY_WORKFLOW_STATUS_ORDER.includes(value as LegacyWorkflowStatus)
  );
}

export function upgradeLegacyWorkflowStatus(value: unknown): WorkflowStatus | null {
  if (isWorkflowStatus(value)) return value;
  if (value === "build") return "doing";
  if (value === "ship") return "done";
  if (!isLegacyWorkflowStatus(value)) return null;
  return WORKFLOW_STATUS_CUTOVER_MAP[value];
}
