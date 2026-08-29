import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  requireSidebarCustomSectionsFacts,
  SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID,
} from "../../../scripts/scenarios/scenarios/sidebar-custom-sections";

describe("sidebar/custom-sections over the real Core transport", () => {
  test("materializes mixed placement, aggregate activity, and a pager boundary", async () => {
    await withCoreScenario(
      { scenarioId: SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID },
      async ({ facts, seed }) => {
        const observed = requireSidebarCustomSectionsFacts(facts);
        expect(observed).toMatchObject({
          directItemCount: 53,
          effectiveSessionCount: 52,
          hasRunning: true,
          hasUnread: true,
        });

        const items = await seed.listSidebarSectionItems(observed.sectionId);
        expect(items.items).toHaveLength(53);
        expect(items.items.some((item) => item.kind === "project")).toBe(true);
        expect(
          items.items.some(
            (item) =>
              item.kind === "session" &&
              item.session.sessionId === observed.runningSessionId &&
              item.session.status?.statusType === "active",
          ),
        ).toBe(true);
        expect(
          items.items.some(
            (item) =>
              item.kind === "session" &&
              item.session.sessionId === observed.firstDraftSessionId &&
              item.session.threadId === null,
          ),
        ).toBe(true);
      },
    );
  });
});
