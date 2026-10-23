import { expect, type Page } from "@playwright/test";

/** Settings workflows use the public shortcut; account-menu tests own the pointer entry. */
export async function openWorkbenchSettings(page: Page): Promise<void> {
  const settings = page.getByTestId("settings-route-shell");
  const home = page.getByRole("button", { name: "Home", exact: true });
  await expect(settings.or(home).first()).toBeVisible();
  if (await settings.isVisible()) return;
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settings).toBeVisible();
}
