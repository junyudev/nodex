import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../scripts/scenarios/scenarios/board-dense";
import { openBoardPageFromCard } from "./support/open-board-page";

test("keeps Page description editing and history live across creation and retained view remounts", async () => {
  test.setTimeout(120_000);
  await withElectronScenario(
    { label: "editor-resource-lifetimes", scenarioId: BOARD_DENSE_SCENARIO_ID },
    async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const mod = process.platform === "darwin" ? "Meta" : "Control";
      await page.getByRole("button", { name: "Open Dense Board", exact: true }).click();
      await page.getByRole("button", { name: "Create Page in Triage", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const title = dialog.getByLabel("Page title", { exact: true });
      const description = dialog.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      await title.fill("Lifecycle first Page");
      await description.click();
      await page.keyboard.type("First description");
      await expect(description).toHaveText("First description");
      await page.keyboard.press(`${mod}+Z`);
      await expect(description).toHaveText("");
      await page.keyboard.press(`${mod}+Shift+Z`);
      await expect(description).toHaveText("First description");
      await dialog.getByRole("switch", { name: "Create more Pages" }).click();
      await dialog.getByRole("button", { name: "Create page", exact: true }).click();
      await expect(title).toHaveValue("");
      await expect(description).toHaveText("");

      await title.fill("Lifecycle second Page");
      await description.click();
      await page.keyboard.type("Second description");
      await page.keyboard.press(`${mod}+Z`);
      await expect(description).toHaveText("");
      await page.keyboard.press(`${mod}+Shift+Z`);
      await expect(description).toHaveText("Second description");
      await dialog.getByRole("switch", { name: "Create more Pages" }).click();
      await dialog.getByRole("button", { name: "Create page", exact: true }).click();
      await expect(dialog).toHaveCount(0);

      const card = page.locator('[data-board-column-id="triage"] [data-board-uuid-v7]').filter({
        has: page.getByRole("button", { name: "Open Page Lifecycle first Page", exact: true }),
      });
      await openBoardPageFromCard({ page, card, tabName: "Lifecycle first Page" });
      const editor = page
        .getByRole("tabpanel", { name: /Lifecycle first Page$/ })
        .locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      await expect(editor).toHaveText("First description");
      await editor.click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
      await page.keyboard.type(" retained");
      await expect(editor).toHaveText("First description retained");
      const secondCard = page
        .locator('[data-board-column-id="triage"] [data-board-uuid-v7]')
        .filter({
          has: page.getByRole("button", { name: "Open Page Lifecycle second Page", exact: true }),
        });
      await openBoardPageFromCard({ page, card: secondCard, tabName: "Lifecycle second Page" });
      await expect(editor).toBeHidden();
      await page.getByRole("tab", { name: "Lifecycle first Page", exact: true }).click();
      await editor.click();
      await page.keyboard.press(`${mod}+Z`);
      await expect(editor).toHaveText("First description");
      await page.keyboard.press(`${mod}+Shift+Z`);
      await expect(editor).toHaveText("First description retained");
      expect(errors).toEqual([]);
    },
  );
});
