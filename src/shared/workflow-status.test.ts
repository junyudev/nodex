import { describe, expect, it } from "vite-plus/test";
import {
  COMPLETED_WORKFLOW_STATUS,
  DEFAULT_WORKFLOW_STATUS_COLUMNS,
  compareWorkflowStatuses,
  isWorkflowStatus,
  resolveWorkflowStatusName,
} from "./workflow-status";

describe("Page workflow status", () => {
  it("uses the fixed domain-neutral workflow and completes at Done", () => {
    expect(DEFAULT_WORKFLOW_STATUS_COLUMNS).toEqual([
      { id: "triage", name: "Triage" },
      { id: "plan", name: "Todo" },
      { id: "doing", name: "In Progress" },
      { id: "review", name: "In Review" },
      { id: "done", name: "Done" },
      { id: "canceled", name: "Canceled" },
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
    expect(isWorkflowStatus("canceled")).toBe(true);
  });
});

describe("Source-owned stage names", () => {
  it("uses a renamed option without changing the stage identity", () => {
    expect(resolveWorkflowStatusName("doing", [{ id: "doing", name: "In progress" }])).toBe(
      "In progress",
    );
  });
  it("falls back for a missing stage and retains unknown identities", () => {
    expect(resolveWorkflowStatusName("doing", [])).toBe("In Progress");
    expect(resolveWorkflowStatusName("unknown", [])).toBe("unknown");
  });
});
