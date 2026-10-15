import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";

export function assertMuseSubagentApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assert.deepEqual(
    projection.runs.map((run) => run.status),
    ["completed"],
  );

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0]!;
  assert.equal(subagent.status, "completed");
  assert.match(subagent.result ?? "", /^Written\.?$/u);
  if (subagent.childThreadId === null) throw new Error("The subagent has no child thread");
  const child = result.projections.get(subagent.childThreadId);
  if (child === undefined) throw new Error("The child thread has no projection");
  assert.lengthOf(child.runtimeRequests, 0);
  assert.deepEqual(
    child.messages.map((message) => [message.role, message.text]),
    [
      ["user", subagent.prompt],
      ["assistant", subagent.result],
    ],
  );
}
