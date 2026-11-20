import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Opens the conversation's subagents panel from its summary. A narrow conversation keeps the
 * summary behind its header toggle instead of beside the transcript; the toggle's pressed state,
 * not a mounted panel, says whether the summary is already open.
 */
export const openSubagentsPanel = async (page: Page): Promise<void> => {
  const summary = await openSummaryPanel(page);
  const open = summary.getByRole("button", { name: "Open subagents" }).first();
  await expect(open).toBeVisible({ timeout: 30_000 });
  await open.click();
};

/**
 * Opens the subagents panel as its list, whose sections group and count subagents by status. The
 * panel opens as a map of who delegated what until the person chooses the list.
 */
export const openSubagentsList = async (page: Page): Promise<void> => {
  await openSubagentsPanel(page);
  await selectSubagentsList(page);
};

export const selectSubagentsList = async (page: Page): Promise<void> => {
  const list = page.getByRole("radio", { name: "List", exact: true });
  await expect(list).toBeVisible();
  if ((await list.getAttribute("aria-checked")) !== "true") await list.click();
  await expect(list).toHaveAttribute("aria-checked", "true");
};

/**
 * Opens the conversation's summary and returns it. A closed pinned summary stays mounted, fully
 * transparent, for its exit motion, so only the toggle says whether it is open.
 */
export const openSummaryPanel = async (page: Page): Promise<Locator> => {
  const toggle = page.getByRole("button", { name: /^Toggle (pinned )?summary$/u }).first();
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  return page
    .locator('[data-thread-summary-panel-mode="pinned"][data-thread-summary-panel-open="true"]')
    .or(page.locator('[data-thread-summary-panel-mode="popover"]'));
};
