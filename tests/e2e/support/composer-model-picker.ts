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

/**
 * Moves the open picker's effort track to the stop named `label`. Holding the pointer previews
 * each stop without committing it, so only the named effort is written.
 */
export const chooseComposerEffort = async (page: Page, label: string): Promise<void> => {
  await openComposerModelPicker(page);
  const effort = page.getByRole("slider", { name: "Effort", exact: true });
  await expect(effort).toBeEnabled();
  const last = Number(await effort.getAttribute("max"));
  const track = page.locator('[data-slot="slider-track"]').filter({ has: effort });
  const box = await track.boundingBox();
  if (!box || !(last > 0)) throw new Error("The effort track is not laid out");
  const y = box.y + box.height / 2;
  const stopX = (index: number) => box.x + (box.width * index) / last;
  await page.mouse.move(stopX(0), y);
  await page.mouse.down();
  for (let index = 0; index <= last; index += 1) {
    await page.mouse.move(stopX(index), y, { steps: 2 });
    if ((await effort.getAttribute("aria-valuetext")) !== label) continue;
    await page.mouse.up();
    await expect(effort).toHaveAttribute("aria-valuetext", label);
    await expect(effort).toBeEnabled();
    return;
  }
  await page.mouse.up();
  throw new Error(`The picker offers no ${label} effort`);
};

/** Turns the open picker's Fast mode on or off. */
export const setComposerFast = async (page: Page, on: boolean): Promise<void> => {
  await openComposerModelPicker(page);
  const fast = page.getByRole("button", { name: "Fast", exact: true });
  if ((await fast.getAttribute("aria-pressed")) !== String(on)) await fast.click();
  await expect(fast).toHaveAttribute("aria-pressed", String(on));
  await expect(fast).toBeEnabled();
};
