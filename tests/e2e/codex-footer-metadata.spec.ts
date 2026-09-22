import { expect, test } from "@playwright/test";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { openNewChatDraft } from "./support/new-chat-draft";

test("shows skills, memory citations, and automatic review details for a completed response", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "footer-metadata",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_FOOTER_METADATA: "1",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "1500",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  try {
    const page = await harness.launch();
    await page.emulateMedia({ colorScheme: "dark" });
    const scene = await openNewChatDraft(page);
    await scene
      .locator('[data-codex-composer="true"][aria-label="Do anything"]')
      .fill("Review the footer metadata");
    await scene.getByRole("button", { name: "Send prompt", exact: true }).click();
    const reply = page.getByText("The metadata review is complete.", { exact: true });
    await expect(reply).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await reply.hover();
    const skills = page.getByRole("button", { name: "Skills", exact: true });
    const memories = page.getByRole("button", { name: "1 memory citation", exact: true });
    const reviews = page.getByRole("button", {
      name: "Auto-review stats (1 rejected)",
      exact: true,
    });
    await expect(skills).toHaveCount(1);
    await expect(memories).toHaveCount(1);
    await expect(reviews).toHaveCount(1);
    await skills.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip.getByRole("link", { name: "footer-review", exact: true })).toBeVisible();
    await expect(tooltip.getByText("Project", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("skills-tooltip.png") });
    await memories.hover();
    await expect(
      tooltip.getByText("Message actions follow project conventions.", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("memory-tooltip.png") });
    await reviews.click();
    const dialog = page.getByRole("dialog", { name: "Auto-review stats", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.locator("summary").filter({ hasText: "touch protected.txt" }).click();
    await expect(
      dialog.getByText("Changing the protected file was not requested.", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(/cat .*\.agents\/skills\/footer-review\/SKILL.md/).first(),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("auto-review-dialog.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
