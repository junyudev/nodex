import { expect, type Page } from "@playwright/test";

/** Open Settings through the rail menu, independent of the current keyboard focus. */
export async function openWorkbenchSettings(page: Page): Promise<void> {
  const settings = page.getByTestId("settings-route-shell");
  const home = page.getByRole("button", { name: "Home", exact: true });
  await expect(settings.or(home).first()).toBeVisible();
  if (await settings.isVisible()) return;
  await page.getByRole("button", { name: "Spaces and settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
}

/** Leave Settings with the Workbench shortcut, outside any focused editor or popup. */
export async function closeWorkbenchSettings(page: Page): Promise<void> {
  const settings = page.getByTestId("settings-route-shell");
  await settings.locator(':scope > [tabindex="-1"]').focus();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
}
