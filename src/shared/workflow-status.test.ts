import { describe, expect, it } from "vite-plus/test";
import {
  COMPLETED_WORKFLOW_STATUS,
  WORKFLOW_STATUS_COLUMNS,
  compareWorkflowStatuses,
  isWorkflowStatus,
} from "./workflow-status";

describe("Page workflow status", () => {
  it("uses the fixed domain-neutral workflow and completes at Done", () => {
    expect(WORKFLOW_STATUS_COLUMNS).toEqual([
      { id: "triage", name: "Triage" },
      { id: "plan", name: "Plan" },
      { id: "doing", name: "Doing" },
      { id: "review", name: "Review" },
      { id: "done", name: "Done" },
    ]);
    expect(COMPLETED_WORKFLOW_STATUS).toBe("done");
    expect(compareWorkflowStatuses("doing", "review")).toBeLessThan(0);
    expect(compareWorkflowStatuses("review", "done")).toBeLessThan(0);
  });

  it("rejects retired identities at ordinary input boundaries", () => {
    for (const status of ["build", "ship", "in_progress", "Done", null]) {
      expect(isWorkflowStatus(status)).toBe(false);
    }
    expect(isWorkflowStatus("doing")).toBe(true);
    expect(isWorkflowStatus("done")).toBe(true);
  });
});
