import { SUBAGENT_V2_APPROVAL_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function museSubagentApprovalInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "full-access",
    steps: [
      { type: "message", text: SUBAGENT_V2_APPROVAL_PROMPT },
    ],
  };
}
