import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID,
  requireDatabaseSettingsConfigurationFacts,
} from "../../../scripts/scenarios/scenarios/database-settings-configuration";

describe("database/settings-configuration authoritative scenario", () => {
  test("materializes distinct Views, typed Properties, inline rules, and personal overrides", async () => {
    await withCoreScenario(
      { scenarioId: DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID },
      async (ctx) => {
        const facts = requireDatabaseSettingsConfigurationFacts(ctx.facts);
        expect(facts.boardViewId).not.toBe(facts.listViewId);
        expect(facts.customPropertyKinds).toEqual([
          "checkbox",
          "date",
          "datetime",
          "multi_select",
          "number",
          "relation",
          "select",
          "text",
        ]);
        expect(facts.deletedPropertyCount).toBe(1);
        expect(facts.pageLayoutVisibilities).toEqual(
          expect.arrayContaining(["always_show", "hide_when_empty", "always_hide"]),
        );
        expect(facts.quickFilterCount).toBe(2);
        expect(facts.advancedFilterRuleCount).toBe(2);
        expect(facts.sortCount).toBe(2);
        expect(facts.personalSortOverrideCount).toBe(2);
      },
    );
  });
});
