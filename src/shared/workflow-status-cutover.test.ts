import { describe, expect, it } from "vite-plus/test";
import {
  LEGACY_WORKFLOW_STATUS_ORDER,
  WORKFLOW_STATUS_CUTOVER_MAP,
  upgradeLegacyWorkflowStatus,
} from "./workflow-status-cutover";
import { WORKFLOW_STATUS_ORDER } from "./workflow-status";

describe("workflow status cutover", () => {
  it("maps every legacy status bijectively and preserves workflow order", () => {
    const mapped = LEGACY_WORKFLOW_STATUS_ORDER.map(
      (status) => WORKFLOW_STATUS_CUTOVER_MAP[status],
    );

    expect(mapped).toEqual(WORKFLOW_STATUS_ORDER);
    expect(new Set(mapped).size).toBe(WORKFLOW_STATUS_ORDER.length);
  });

  it("normalizes legacy and current values at migration boundaries", () => {
    expect(upgradeLegacyWorkflowStatus("draft")).toBe("triage");
    expect(upgradeLegacyWorkflowStatus("in_progress")).toBe("doing");
    expect(upgradeLegacyWorkflowStatus("in_review")).toBe("review");
    expect(upgradeLegacyWorkflowStatus("done")).toBe("done");
    expect(upgradeLegacyWorkflowStatus("doing")).toBe("doing");
    expect(upgradeLegacyWorkflowStatus("build")).toBe("doing");
    expect(upgradeLegacyWorkflowStatus("ship")).toBe("done");
    expect(upgradeLegacyWorkflowStatus("unknown")).toBeNull();
    expect(upgradeLegacyWorkflowStatus(null)).toBeNull();
  });
});
