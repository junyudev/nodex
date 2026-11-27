import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Reveals the Page's counted Files tree, including body-only Files in quiet Properties. The
 * Property's row states its count, which must be `total`; its label unfolds the tree.
 */
export async function pageFilesTree(stage: Locator, total: number): Promise<Locator> {
  const property = stage.locator('[data-page-files-property="true"]');
  if (!(await property.isVisible())) {
    await stage.getByRole("button", { name: /\d+ more propert(?:y|ies)/u }).click();
  }
  await expect(
    property.getByRole("button", {
      name: new RegExp(`^${total} ${total === 1 ? "file" : "files"}(?: New files)?$`, "u"),
    }),
  ).toBeVisible();
  const label = property.getByRole("button", { name: "Files", exact: true });
  if ((await label.getAttribute("aria-expanded")) === "false") await label.click();
  await expect(label).toHaveAttribute("aria-expanded", "true");
  const tree = property.getByRole("tree", { name: "Page files", exact: true });
  await expect(tree).toBeVisible();
  // Beside attachments, the body's own Files wait in a group that starts folded.
  const inPage = tree.getByRole("treeitem", { name: "In page", exact: true });
  if ((await inPage.count()) > 0 && (await inPage.getAttribute("aria-expanded")) === "false") {
    await inPage.click();
  }
  return tree;
}

/** Tree activation previews a File in a tab; management is an explicit context action. */
export async function managePageFile(page: Page, item: Locator): Promise<Locator> {
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Manage in Page files", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Page files", exact: true });
  await expect(manager).toBeVisible();
  return manager;
}
