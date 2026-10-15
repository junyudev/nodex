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

export function assertOpenCodeChildApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [OPENCODE_SUBAGENT_PROMPT]);
  assertAssistantTextIncludes(projection, "PARENT_OK");

  // The delegation itself still completes.
  assert.lengthOf(projection.subagents, 1);
  assert.equal(projection.subagents[0]?.status, "completed");
  assert.include(projection.subagents[0]?.result ?? "", "CHILD_OK");
}
