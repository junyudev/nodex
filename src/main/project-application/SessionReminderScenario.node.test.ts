import { expect, test } from "vitest";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  SIDEBAR_CHAT_STATUS_SCENARIO_ID,
  requireSidebarChatStatusFacts,
} from "../../../scripts/scenarios/scenarios/sidebar-chat-status";

test("the chat status scenario retains pending and overdue reminders across Core restart", async () => {
  await withCoreScenario({ scenarioId: SIDEBAR_CHAT_STATUS_SCENARIO_ID }, async (scenario) => {
    const facts = requireSidebarChatStatusFacts(scenario.facts);
    const pending = await scenario.seed.readSession(facts.sessionIdsByKey.pendingReminder);
    const due = await scenario.seed.readSession(facts.sessionIdsByKey.dueReminder);
    expect(Date.parse(pending!.remindAt!)).toBeGreaterThan(Date.now());
    expect(Date.parse(due!.remindAt!)).toBeLessThanOrEqual(Date.now());
    await scenario.withStoppedCore(async () => {});
    expect((await scenario.seed.readSession(pending!.id))?.remindAt).toBe(pending!.remindAt);
    expect((await scenario.seed.readSession(due!.id))?.remindAt).toBe(due!.remindAt);
  });
});
