import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_V2_NESTED_APPROVAL_PROMPT,
} from "../shared.ts";

/**
 * Codex asks for a grandchild's command approval on the grandchild's own
 * native thread and turn. The request is asked on the top-level thread and
 * run instead, under the top-level subagent that leads to the grandchild.
 */
export function assertSubagentV2NestedApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [SUBAGENT_V2_NESTED_APPROVAL_PROMPT]);
  const run = projection.runs[0]!;

  assert.lengthOf(projection.subagents, 1);
  const child = projection.subagents[0]!;
  assert.equal(child.origin, "provider_native");
  assert.equal(child.status, "completed");
  assert.equal(child.result, "Written.");
  const childProjection = result.projections.get(child.childThreadId!);
  assert.isDefined(childProjection);
  assert.lengthOf(childProjection.subagents, 1);
  const grandchild = childProjection.subagents[0]!;
  assert.equal(grandchild.status, "completed");
  assert.equal(grandchild.result, "Written.");
  const grandchildProjection = result.projections.get(grandchild.childThreadId!);
  assert.isDefined(grandchildProjection);
  assert.equal(grandchildProjection.thread.lineage.parentThreadId, childProjection.thread.id);
  assert.equal(grandchildProjection.thread.lineage.rootThreadId, projection.thread.id);

  assert.lengthOf(projection.runtimeRequests, 0);
  assert.isFalse(projection.turnItems.some((item) => item.type === "approval_request"));

  // Neither native child thread holds a request; the grandchild ran the command.
  for (const nested of [childProjection, grandchildProjection]) {
    assert.lengthOf(nested.runtimeRequests, 0);
    assert.isFalse(nested.turnItems.some((item) => item.type === "approval_request"));
  }
  const command = grandchildProjection.turnItems.find((item) => item.type === "command_execution");
  assert.equal(command?.status, "completed");
  assert.isTrue(
    grandchildProjection.turnItems.some(
      (item) => item.type === "assistant_message" && item.text.includes("Written."),
    ),
  );
}
