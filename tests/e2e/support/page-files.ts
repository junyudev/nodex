import { expect, type Locator, type Page } from "@playwright/test";

/** Reveals the Page's counted Files tree, including body-only Files in quiet Properties. */
export async function pageFilesTree(stage: Locator, total: number): Promise<Locator> {
  const property = stage.locator('[data-page-files-property="true"]');
  if (!(await property.isVisible())) {
    await stage.getByRole("button", { name: /\d+ more propert(?:y|ies)/u }).click();
  }
  const summary = property.getByRole("button", {
    name: new RegExp(`^${total} ${total === 1 ? "file" : "files"}(?: New files)?$`, "u"),
  });
  await expect(summary).toBeVisible();
  if ((await summary.getAttribute("aria-expanded")) === "false") await summary.click();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  const tree = property.getByRole("tree", { name: "Page files", exact: true });
  await expect(tree).toBeVisible();
  return tree;
}

/** Tree activation previews a File in a tab; management is an explicit context action. */
export async function managePageFile(page: Page, item: Locator): Promise<Locator> {
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Manage in Page files…", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Page files", exact: true });
  await expect(manager).toBeVisible();
  return manager;
}
