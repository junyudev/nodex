import { expect, type Locator, type Page } from "@playwright/test";

export async function selectEditorBlockRange({
  page,
  editor,
  firstBlock,
  lastBlock,
}: {
  page: Page;
  editor: Locator;
  firstBlock: Locator;
  lastBlock: Locator;
}): Promise<void> {
  const selectionEndpointBox = async (block: Locator) => {
    const inlineContent = block.locator(":scope > .bn-block-content .bn-inline-content");
    if ((await inlineContent.count()) > 0) return await inlineContent.boundingBox();
    return await block.boundingBox();
  };
  const [firstBox, lastBox] = await Promise.all([
    selectionEndpointBox(firstBlock),
    selectionEndpointBox(lastBlock),
  ]);
  if (!firstBox || !lastBox) throw new Error("Editor selection endpoints have no layout boxes");

  await page.mouse.move(firstBox.x + 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(lastBox.x + lastBox.width - 2, lastBox.y + lastBox.height / 2, {
    steps: 20,
  });
  await page.mouse.up();
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+/`);
  const menu = page.getByRole("dialog", { name: "Block actions" });
  await menu.waitFor();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(editor).toBeVisible();
}
