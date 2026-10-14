import type { Page } from "playwright";

/**
 * Selects the Project's Board. A Project opens on its Inbox Home; the Board is an ordinary
 * `DB View` tab beside it, opened from the Home's Board button when the Scene has none yet.
 */
export const openProjectBoard = async (page: Page): Promise<void> => {
  const tabs = page.locator("[data-panel-tab-row]");
  const home = tabs.getByRole("tab", { name: "Inbox", exact: true });
  const board = tabs.getByRole("tab", { name: "DB View", exact: true }).first();
  await home.waitFor();
  if ((await board.count()) === 0) {
    if ((await home.getAttribute("aria-selected")) !== "true") await home.click();
    await page.getByRole("button", { name: "Open Board", exact: true }).click();
  } else if ((await board.getAttribute("aria-selected")) !== "true") {
    await board.click();
  }
  await board.and(page.locator('[aria-selected="true"]')).waitFor();
};
