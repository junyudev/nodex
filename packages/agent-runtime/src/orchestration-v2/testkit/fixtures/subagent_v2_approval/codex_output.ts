import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_V2_APPROVAL_PROMPT,
} from "../shared.ts";

/** Native child permissions are answered automatically on the original Run. */
export function assertSubagentV2ApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [SUBAGENT_V2_APPROVAL_PROMPT]);
  const run = projection.runs[0]!;

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0]!;
  assert.equal(subagent.origin, "provider_native");
  assert.equal(subagent.status, "completed");
  assert.equal(subagent.result, "Written.");
  assert.isNotNull(subagent.childThreadId);

  assert.lengthOf(projection.runtimeRequests, 0);
  assert.isFalse(projection.turnItems.some((item) => item.type === "approval_request"));

  // The child keeps its own work and answer, and never holds a request.
  const child = result.projections.get(subagent.childThreadId!);
  assert.isDefined(child);
  assert.lengthOf(child.runtimeRequests, 0);
  assert.isFalse(child.turnItems.some((item) => item.type === "approval_request"));
  const command = child.turnItems.find((item) => item.type === "command_execution");
  assert.equal(command?.status, "completed");
  assert.isTrue(
    child.turnItems.some(
      (item) => item.type === "assistant_message" && item.text.includes("Written."),
    ),
  );
}
