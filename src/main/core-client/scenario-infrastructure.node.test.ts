import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  BOARD_DENSE_PRIMARY_PAGE_KEY,
  BOARD_DENSE_SCENARIO_ID,
  requireBoardDenseScenarioFacts,
} from "../../../scripts/scenarios/scenarios/board-dense";
import { createUuidV7 } from "../../shared/uuid-v7";

describe("authoritative isolated scenarios over CoreClient", () => {
  test("materializes board/dense and commits a later Document mutation without Electron", async () => {
    await withCoreScenario({ scenarioId: BOARD_DENSE_SCENARIO_ID }, async (context) => {
      const facts = requireBoardDenseScenarioFacts(context.facts);
      expect(facts).toMatchObject({
        totalRows: Object.keys(context.manifest.pageIdsByKey).length,
        groups: { triage: 3, plan: 2, build: 3, review: 1, ship: 1 },
        primaryBuildPage: {
          title: "Unify Database View rendering",
          documentReadiness: "ready",
        },
      });
      const primaryPageId = context.manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY];
      if (!primaryPageId) throw new Error("Scenario manifest has no primary Page");
      const before = await context.seed.readPage(context.manifest.projectId, primaryPageId);
      const mutation = await context.seed.replaceOwnedDocument({
        operationId: createUuidV7(),
        mutationId: createUuidV7(),
        clientSessionId: "scenario:core-follow-up",
        projectId: context.manifest.projectId,
        pageId: primaryPageId,
        nfm: "# Updated rendering contract\n\nThe Core-only harness committed this change.",
      });
      const after = await context.seed.readPage(
        context.manifest.projectId,
        primaryPageId,
        mutation.commitSeq,
      );
      expect(mutation.commitSeq).toBeGreaterThan(before.commitSeq);
      expect(after.commitSeq).toBeGreaterThanOrEqual(mutation.commitSeq);
      expect(after.descriptionPreview).toContain("Updated rendering contract");
    });
  });
});
