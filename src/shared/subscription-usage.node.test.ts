import { expect, test } from "vite-plus/test";
import { antigravityAgent } from "./agents/antigravity";
import { claudeAgent } from "./agents/claude";
import { openCodeAgent } from "./agents/opencode";
import { declaredSubscriptionAgents } from "./subscription-usage";

const profile = (
  driver: string,
  id: string,
  patch: { readonly enabled?: boolean; readonly settings?: Record<string, unknown> } = {},
) => ({ id, driver, enabled: patch.enabled ?? true, settings: patch.settings ?? {} });

test("declares only the saved profiles whose accounts can report subscription usage", () => {
  expect(
    declaredSubscriptionAgents([
      profile(claudeAgent.driver, "claude_work"),
      profile(claudeAgent.driver, "claude_off", { enabled: false }),
      profile(antigravityAgent.driver, "antigravity_google", {
        settings: { authMethod: "oauth-personal" },
      }),
      // A key is billed by use and reports no plan limits.
      profile(antigravityAgent.driver, "antigravity_key", {
        settings: { authMethod: "gemini-api-key" },
      }),
      profile(openCodeAgent.driver, "opencode_default"),
      profile("someFutureAgent", "future_1"),
    ]),
  ).toEqual({
    [claudeAgent.usageMeter.preference]: ["claude_work"],
    [antigravityAgent.usageMeter.preference]: ["antigravity_google"],
  });
});

test("names every settings-tracked meter, with or without a profile to read", () => {
  expect(declaredSubscriptionAgents([])).toEqual({
    [claudeAgent.usageMeter.preference]: [],
    [antigravityAgent.usageMeter.preference]: [],
  });
});
