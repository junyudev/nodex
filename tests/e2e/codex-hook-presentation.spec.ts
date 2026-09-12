import { expect, test } from "@playwright/test";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { openNewChatDraft } from "./support/new-chat-draft";

test("shows completed lifecycle hooks only through accessible message action tooltips", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "hook-presentation",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "2500",
      NODEX_FAKE_CODEX_HOOK_TURN: "1",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  try {
    const page = await harness.launch();
    await page.emulateMedia({ colorScheme: "light" });
    const scene = await openNewChatDraft(page);
    const composer = scene.locator('[data-codex-composer="true"][aria-label="Do anything"]');
    await expect(composer).toBeVisible();
    await composer.fill("Check the session hook");
    const sendButton = scene.getByRole("button", { name: "Send prompt", exact: true });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();
    const reply = page.getByText("The hook completed successfully.", { exact: true });
    await expect(reply).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Hooks", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    const indicator = page.getByRole("button", { name: "Hooks", exact: true });
    await expect(indicator).toHaveCount(1);
    await expect(page.getByText("SessionStart", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Injected hook context must stay hidden", { exact: true }),
    ).toHaveCount(0);
    await reply.hover();
    await page.screenshot({ path: testInfo.outputPath("hooks-action-row.png") });
    await indicator.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip.getByText("SessionStart", { exact: true })).toBeVisible();
    await expect(tooltip.getByText("User", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("hooks-hover.png") });
    await tooltip.screenshot({ path: testInfo.outputPath("hooks-tooltip.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({ path: testInfo.outputPath("hooks-hover-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
    await indicator.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(tooltip.getByText("SessionStart", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
