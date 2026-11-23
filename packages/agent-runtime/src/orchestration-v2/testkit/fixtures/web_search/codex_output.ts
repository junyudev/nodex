import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@nodex/runtime-contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertExecutionNodeKinds,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  WEB_SEARCH_PROMPT,
} from "../shared.ts";

const WEB_SEARCH_QUERY = "FIFA World Cup 2026 ticket prices official";

export function assertWebSearchOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertExecutionNodeKinds(projection, ["root_turn", "tool_call", "assistant_message"]);
  // gpt-6 models announce the search in a commentary message before the final answer.
  assertConversationMessageRoles(projection, ["user", "assistant", "assistant"]);
  assertTurnItemTypes(projection, ["user_message", "web_search", "assistant_message"]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertUserMessagesInclude(projection, [WEB_SEARCH_PROMPT]);
  assertAssistantTextIncludes(projection, "web search fixture complete");

  const webSearchItems = projection.turnItems.filter((item) => item.type === "web_search");
  assert.lengthOf(webSearchItems, 1);
  assert.equal(webSearchItems[0]?.status, "completed");
  assert.include(webSearchItems[0]?.patterns ?? [], WEB_SEARCH_QUERY);
  assert.deepEqual(webSearchItems[0]?.action, {
    type: "search",
    query: WEB_SEARCH_QUERY,
    queries: null,
  });
  // The scenario reads this projection back from the Runtime's SQLite store.
  const results = webSearchItems[0]?.results ?? [];
  assert.lengthOf(results, 27);
  assert.deepEqual(results[0], {
    type: "text_result",
    title: "10. How does FIFA determine ticket prices for the FIFA World Cup 2026™? – FIFA World Cup 2026™",
    url: "https://gpcustomersupportfwc2026.tickets.fifa.com/hc/en-gb/articles/30201776314397-10-How-does-FIFA-determine-ticket-prices-for-the-FIFA-World-Cup-2026",
    snippet: "With this approach, FIFA considers that ticket price adaptations help ensure fair market value for FIFA World Cup 2026™ matches.",
  });
}
