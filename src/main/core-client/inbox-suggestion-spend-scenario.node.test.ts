import { describe, expect, test } from "vite-plus/test";
import { runScenarioInbox } from "../../../scripts/scenarios/adapters/core-client-seed-runtime";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  INBOX_SUGGESTION_SPEND_SCENARIO_ID,
  INBOX_SUGGESTION_SPEND_SCENARIO_REVISION,
  requireInboxSuggestionSpendScenarioFacts,
} from "../../../scripts/scenarios/scenarios/inbox-suggestion-spend";

describe("inbox/suggestion-spend scenario", () => {
  test("keeps current, outdated, unrequested, and grouped advice without starting Agents", async () => {
    await withCoreScenario({ scenarioId: INBOX_SUGGESTION_SPEND_SCENARIO_ID }, async (context) => {
      expect(requireInboxSuggestionSpendScenarioFacts(context.facts)).toEqual({
        scenarioId: INBOX_SUGGESTION_SPEND_SCENARIO_ID,
        scenarioRevision: INBOX_SUGGESTION_SPEND_SCENARIO_REVISION,
        messageCount: 5,
        currentProposalCount: 2,
        outdatedProposalCount: 1,
        unrequestedCount: 1,
        groupedMemberCount: 2,
      });
      const items = (await context.seed.readInbox("inbox")).items;
      const message = (key: string) =>
        items.find((item) => item.pageId === context.manifest.pageIdsByKey[key]);
      expect(message("current")).toMatchObject({
        suggestionState: "settled",
        proposal: {
          origin: "agent",
          state: "open",
          outdated: false,
          action: { type: "new_chat", projectId: context.manifest.projectId },
        },
      });
      expect(message("outdated")).toMatchObject({
        suggestionState: "settled",
        proposal: { origin: "agent", state: "open", outdated: true },
      });
      expect(message("outdated")?.body).toContain("Include the pricing section");
      expect(message("unrequested")).toMatchObject({ suggestionState: "none", proposal: null });
      const group = message("navigation")?.proposal;
      expect(group?.pageIds).toEqual([
        context.manifest.pageIdsByKey.navigation,
        context.manifest.pageIdsByKey.keyboard,
      ]);
      expect(message("keyboard")?.proposal).toEqual(group);
      for (const item of items) {
        expect(item.basis.contentHash).toMatch(/^[a-f0-9]{64}$/u);
        const member = item.proposal?.basis.find((basis) => basis.pageId === item.pageId);
        if (member) expect(member).toEqual(item.basis);
      }
      expect(
        await runScenarioInbox(context.runtime, (inbox) => inbox.suggestionRequests(16)),
      ).toEqual([]);
      expect(await runScenarioInbox(context.runtime, (inbox) => inbox.outbox(16))).toEqual([]);
    });
  });
});
