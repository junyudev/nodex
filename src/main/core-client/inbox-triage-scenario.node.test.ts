import { describe, expect, test } from "vite-plus/test";

import { projectInbox } from "../../shared/inbox";
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
        projectInboxCount: 3,
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

  test("gives the Project its own Inbox of decisions", async () => {
    await withCoreScenario({ scenarioId: INBOX_TRIAGE_SCENARIO_ID }, async (context) => {
      const scope = projectInbox(context.manifest.projectId);
      const items = (await context.seed.readInbox("inbox", scope)).items;
      expect(items.map((item) => item.scope)).toEqual([scope, scope, scope]);
      // Newest first, like every Inbox window.
      expect(items.map((item) => item.proposal?.action.type)).toEqual([
        "move_to_project",
        "send_to_chat",
        "new_chat",
      ]);
      expect(items.every((item) => item.proposal?.state === "open")).toBe(true);
    });
  });
});
