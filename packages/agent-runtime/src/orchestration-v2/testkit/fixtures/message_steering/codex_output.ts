import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertMessageSteeringOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(transcript.provider, "codex");
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertUserMessagesInclude(projection, [
    MESSAGE_STEERING_INITIAL_PROMPT,
    MESSAGE_STEERING_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  assertAssistantTextIncludes(projection, "steering fixture observed");
  assert.equal(projection.runs.length, 1, "steering must attach to the active run");
  assert.equal(
    projection.providerTurns.length,
    1,
    "active steering must not create a new provider turn",
  );
  const steerMessageIds = projection.turnItems.flatMap((item) =>
    item.type === "user_message" && item.inputIntent === "steer" ? [item.messageId] : [],
  );
  const steerFrames = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && entry.label === "turn/steer" ? [entry.frame] : [],
  );
  assert.lengthOf(steerMessageIds, 1);
  assert.lengthOf(steerFrames, 1);
  assert.equal(
    (steerFrames[0] as { params: { clientUserMessageId: string } }).params.clientUserMessageId,
    steerMessageIds[0],
    "native steering must carry the exact authored message identity",
  );
}
