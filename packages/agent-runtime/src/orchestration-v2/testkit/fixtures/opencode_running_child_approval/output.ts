import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  OPENCODE_SUBAGENT_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCodeRunningChildApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [OPENCODE_SUBAGENT_PROMPT]);
  assertAssistantTextIncludes(projection, "PARENT_OK");

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0]!;
  assert.equal(subagent.status, "completed");
  assert.include(subagent.result ?? "", "CHILD_OK");
  const child = result.projections.get(subagent.childThreadId!);
  assert.isDefined(child);

  // The child keeps its own work and answer, and never holds a request.
  assert.lengthOf(child.runtimeRequests, 0);
  assert.isFalse(child.turnItems.some((item) => item.type === "approval_request"));
  const command = child.turnItems.find((item) => item.type === "command_execution");
  assert.equal(command?.status, "completed");
  assert.isTrue(
    child.turnItems.some(
      (item) => item.type === "assistant_message" && item.text.includes("CHILD_OK"),
    ),
  );
}
