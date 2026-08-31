import { describe, expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  NFM_CODE_BLOCK_ACTIONS_PAGE_KEY,
  NFM_CODE_BLOCK_ACTIONS_SCENARIO_ID,
  requireNfmCodeBlockActionsScenarioFacts,
} from "../../../scripts/scenarios/scenarios/nfm-code-block-actions";

describe("nfm-code-block-actions over the real Core transport", () => {
  test("materializes the authoritative Code Block page through public operations", async () => {
    await withCoreScenario(
      { scenarioId: NFM_CODE_BLOCK_ACTIONS_SCENARIO_ID },
      async ({ facts, manifest }) => {
        const observed = requireNfmCodeBlockActionsScenarioFacts(facts);
        expect(observed).toMatchObject({
          totalRows: Object.keys(manifest.pageIdsByKey).length,
          page: {
            pageId: manifest.pageIdsByKey[NFM_CODE_BLOCK_ACTIONS_PAGE_KEY],
            title: "Exercise Code Block actions",
            documentReadiness: "ready",
          },
        });
      },
    );
  });
});
