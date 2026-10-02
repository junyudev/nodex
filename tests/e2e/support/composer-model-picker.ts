import { expect, type Page } from "@playwright/test";

export const openComposerModelPicker = async (page: Page) => {
  const search = page.getByRole("combobox", { name: "Search models", exact: true });
  if (!(await search.isVisible()))
    await page.getByRole("button", { name: "Select model", exact: true }).click();
  await expect(search).toBeVisible();
  return search;
};

/** A runtime name in the query disambiguates the same model exposed by multiple instances. */
export const chooseComposerModel = async (page: Page, query: string): Promise<void> => {
  const search = await openComposerModelPicker(page);
  await search.fill(query);
  const options = page.getByRole("listbox").getByRole("option");
  await expect(options).toHaveCount(1);
  await search.press("Enter");
  await expect(search).toBeHidden();
};

export const openComposerOptionControl = async (
  page: Page,
  name: "Effort" | "Speed" | "Context" | "Mode" | "Reasoning",
): Promise<void> => {
  await openComposerModelPicker(page);
  await page.getByRole("button", { name: new RegExp(`^${name} `, "u") }).click();
  await expect(page.getByRole("menu")).toBeVisible();
};
