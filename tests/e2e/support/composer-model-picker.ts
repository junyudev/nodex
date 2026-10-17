import { expect, type Page } from "@playwright/test";

export const openComposerModelPicker = async (page: Page) => {
  const search = page.getByRole("combobox", { name: "Search models", exact: true });
  // A picker that was just dismissed may still be animating out; open it once it has gone.
  await expect(async () => {
    if (!(await search.isVisible()))
      await page.getByRole("button", { name: "Select model", exact: true }).click();
    await expect(search).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  // The first catalog read starts Agent execution and probes every provider.
  await expect(page.getByRole("listbox").getByText("Loading models…")).toHaveCount(0, {
    timeout: 60_000,
  });
  return search;
};

export const refreshComposerModels = async (page: Page): Promise<void> => {
  await openComposerModelPicker(page);
  const refresh = page.getByRole("button", { name: "Refresh models", exact: true });
  // The first catalog read starts Agent execution and probes every provider.
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
  await refresh.click();
};

/** A runtime name in the query disambiguates the same model exposed by multiple instances. */
export const chooseComposerModel = async (
  page: Page,
  query: string,
  optionName?: string,
): Promise<void> => {
  const search = await openComposerModelPicker(page);
  await search.fill(query);
  const options = page
    .getByRole("listbox")
    .getByRole("option", optionName === undefined ? {} : { name: optionName, exact: true });
  await expect(options).toHaveCount(1);
  if (optionName === undefined) await search.press("Enter");
  else await options.click();
  await expect(search).toBeHidden();
};

export const openComposerOptionControl = async (
  page: Page,
  name: "Effort" | "Speed" | "Context" | "Mode" | "Reasoning",
): Promise<void> => {
  // The picker may still be closing from a previous choice; reopen it until the control answers.
  await expect(async () => {
    await openComposerModelPicker(page);
    await page
      .getByRole("button", { name: new RegExp(`^${name} `, "u") })
      .click({ timeout: 1_000 });
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
};
