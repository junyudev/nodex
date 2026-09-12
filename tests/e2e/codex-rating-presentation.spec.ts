import { expect, test } from "@playwright/test";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";

test("rates and clears a response through the message action menu", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "rating-presentation",
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
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
    await expect(composer).toBeVisible();
    await composer.fill("Check response rating");
    await expect(composer).toHaveText("Check response rating");
    const sendButton = page.getByRole("button", { name: "Send prompt", exact: true });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();
    const reply = page.getByText("The hook completed successfully.", { exact: true });
    await expect(reply).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await reply.hover();
    const trigger = page.getByRole("button", { name: "Rate response", exact: true });
    await expect(trigger).toHaveCount(1);
    await trigger.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Rate response");
    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Good response", "Bad response"]);
    const triggerBox = await trigger.boundingBox();
    const menuBox = await menu.boundingBox();
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(triggerBox!.y);
    expect(Math.abs(menuBox!.x - triggerBox!.x)).toBeLessThan(8);
    expect(triggerBox!.y - menuBox!.y - menuBox!.height).toBeLessThan(12);
    await page.screenshot({ path: testInfo.outputPath("rating-menu-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({ path: testInfo.outputPath("rating-menu-dark.png") });
    await menu.getByRole("menuitem", { name: "Good response" }).click();
    const removeGood = page.getByRole("button", { name: "Remove good response feedback" });
    await expect(removeGood).toHaveAttribute("aria-pressed", "true");
    await expect(menu).toHaveCount(0);
    await expect(removeGood).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("rating-selected.png") });
    await removeGood.click();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Good response" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Bad response" })).toBeFocused();
    await page.keyboard.press("Enter");
    const removeBad = page.getByRole("button", { name: "Remove bad response feedback" });
    await expect(removeBad).toBeFocused();
    await removeBad.click();
    await trigger.press("ArrowDown");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(menu).toBeVisible();
    await reply.click();
    await expect(menu).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
