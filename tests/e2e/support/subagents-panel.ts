import { expect, type Page } from "@playwright/test";

/**
 * Opens the conversation's subagents panel from its summary. A narrow conversation keeps the
 * summary behind its header toggle instead of beside the transcript; the toggle's pressed state,
 * not a mounted panel, says whether the summary is already open.
 */
export const openSubagentsPanel = async (page: Page): Promise<void> => {
  const toggle = page.getByRole("button", { name: /^Toggle (pinned )?summary$/u }).first();
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const summary = page
    .locator('[data-thread-summary-panel-mode="pinned"][data-thread-summary-panel-open="true"]')
    .or(page.locator('[data-thread-summary-panel-mode="popover"]'));
  const open = summary.getByRole("button", { name: "Open subagents" }).first();
  await expect(open).toBeVisible({ timeout: 30_000 });
  await open.click();
};
