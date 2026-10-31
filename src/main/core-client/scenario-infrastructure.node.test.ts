import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  BOARD_DENSE_PRIMARY_PAGE_KEY,
  BOARD_DENSE_SCENARIO_ID,
  requireBoardDenseScenarioFacts,
} from "../../../scripts/scenarios/scenarios/board-dense";
import { createUuidV7 } from "../../shared/uuid-v7";
import { CROSS_PROVIDER_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/agent-cross-provider-delegation";

describe("authoritative isolated scenarios over CoreClient", () => {
  test("creates two empty Lumen Sessions before any Agent execution exists", async () => {
    await withCoreScenario(
      { scenarioId: CROSS_PROVIDER_SCENARIO_ID },
      async ({ manifest, seed, facts }) => {
        expect(facts.scenarioId).toBe(CROSS_PROVIDER_SCENARIO_ID);
        for (const key of ["parentSession", "releaseNotesSession"]) {
          const id = manifest.entityIdsByKey?.[key];
          if (!id) throw new Error(`Missing ${key}`);
          const session = await seed.readSession(id);
          expect(session).toMatchObject({ projectId: manifest.projectId, thread: null });
          expect(session?.executionRef ?? null).toBeNull();
        }
        expect(manifest.entityIdsByKey?.parentSession).not.toBe(
          manifest.entityIdsByKey?.releaseNotesSession,
        );
      },
    );
  });
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
        markdown: "# Updated rendering contract\n\nThe Core-only harness committed this change.",
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
