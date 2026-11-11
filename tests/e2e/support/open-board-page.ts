import { expect, type Locator, type Page } from "@playwright/test";

/** Opens a Board Page through the canonical card action and waits for active navigation. */
export async function openBoardPageFromCard(input: {
  readonly card: Locator;
  readonly page: Page;
  readonly tabName: string;
}): Promise<void> {
  const card = input.card.filter({ visible: true });
  const openButton = card.locator('[data-database-view-page-open="true"]');
  await expect(card).toBeVisible();
  await expect(openButton).toBeVisible();

  // Opening the fixture Page is setup for the behavior under test. Dispatch
  // directly after actionability checks so delayed card hover UI cannot steal
  // the pointer during repeated Electron runs.
  await openButton.dispatchEvent("click");
  const tab = input.page.getByRole("tab", { name: input.tabName, exact: true });
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
