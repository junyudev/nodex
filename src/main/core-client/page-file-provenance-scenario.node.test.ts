import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  PAGE_FILE_PROVENANCE_SCENARIO_ID,
  requirePageFileProvenanceScenarioFacts,
} from "../../../scripts/scenarios/scenarios/page-file-provenance";

describe("page/file-provenance authoritative scenario", () => {
  test("attributes an Agent's report to its chat and keeps mixed origins apart", async () => {
    await withCoreScenario({ scenarioId: PAGE_FILE_PROVENANCE_SCENARIO_ID }, async (context) => {
      const facts = requirePageFileProvenanceScenarioFacts(context.facts);
      expect([...facts.reportPaths].sort()).toEqual([
        "profile/flamegraph.png",
        "profile/report.html",
        "profile/trace.json",
      ]);

      const report = await context.seed.readPageFileInventory(
        context.manifest.projectId,
        facts.reportPageId,
      );
      for (const item of report.files) {
        expect(item.attachment?.attached_by).toEqual({
          kind: "agent",
          session_id: facts.reportChatId,
          backend: "codex",
        });
      }

      const mixed = await context.seed.readPageFileInventory(
        context.manifest.projectId,
        facts.mixedPageId,
      );
      const byPath = new Map(mixed.files.map((item) => [item.logical_path ?? null, item]));
      expect(byPath.get("brief.md")?.attachment?.attached_by).toEqual({ kind: "person" });
      expect(byPath.get("mockups/settings-dark.png")?.attachment?.attached_by).toEqual({
        kind: "agent",
        session_id: facts.mixedChatId,
        backend: "claude",
      });
      expect(byPath.get(null)).toMatchObject({ attachment: null, body_count: 1 });
    });
  }, 120_000);
});
