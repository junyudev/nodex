import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  INBOX_TRIAGE_SCENARIO_ID,
  requireInboxTriageScenarioFacts,
} from "../../../scripts/scenarios/scenarios/inbox-triage";

describe("inbox/triage scenario", () => {
  test("materializes every Inbox and History state without pending Agent work", async () => {
    await withCoreScenario({ scenarioId: INBOX_TRIAGE_SCENARIO_ID }, async (context) => {
      expect(requireInboxTriageScenarioFacts(context.facts)).toMatchObject({
        entryCount: 6,
        inboxCount: 4,
        needsDecisionCount: 3,
        keptCount: 1,
        dispatchedCount: 1,
        failedSuggestionCount: 1,
      });
      const pending = await context.seed.readInbox("inbox");
      expect(pending.items.some((item) => item.suggestionState === "pending")).toBe(false);
      expect(
        pending.items.some(
          (item) => item.proposal?.state === "dispatching" || item.proposal?.state === "failed",
        ),
      ).toBe(false);
    });
  });
});
