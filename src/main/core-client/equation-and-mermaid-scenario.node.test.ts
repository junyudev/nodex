import { describe, expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  NFM_EQUATION_AND_MERMAID_PAGE_KEY,
  NFM_EQUATION_AND_MERMAID_SCENARIO_ID,
  requireNfmEquationAndMermaidScenarioFacts,
} from "../../../scripts/scenarios/scenarios/nfm-equation-and-mermaid";

describe("nfm-equation-and-mermaid over the real Core transport", () => {
  test("materializes Equation and Mermaid source through public operations", async () => {
    await withCoreScenario(
      { scenarioId: NFM_EQUATION_AND_MERMAID_SCENARIO_ID },
      async ({ facts, manifest }) => {
        const observed = requireNfmEquationAndMermaidScenarioFacts(facts);
        expect(observed).toMatchObject({
          totalRows: Object.keys(manifest.pageIdsByKey).length,
          page: {
            pageId: manifest.pageIdsByKey[NFM_EQUATION_AND_MERMAID_PAGE_KEY],
            title: "Exercise Equation and Mermaid",
            documentReadiness: "ready",
          },
        });
      },
    );
  });
});
