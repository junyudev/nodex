import { SUBAGENT_V2_APPROVAL_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export const SUBAGENT_APPROVAL_PENDING_SHELL_KEY = "subagent-approval-pending";

export function subagentV2ApprovalInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: SUBAGENT_V2_APPROVAL_PROMPT },
      { type: "approve_next_runtime_request", shellSnapshotKeyWhilePending: SUBAGENT_APPROVAL_PENDING_SHELL_KEY },
    ],
  };
}
