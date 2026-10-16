import type { Page } from "playwright";

/** Shows Space, whose sidebar lists the Library's Pages and Databases. */
export const openSpace = async (page: Page): Promise<void> => {
  await page
    .getByRole("navigation", { name: "App navigation", exact: true })
    .getByRole("button", { name: "Space", exact: true })
    .click();
  await page.getByRole("navigation", { name: "Space", exact: true }).waitFor();
};
