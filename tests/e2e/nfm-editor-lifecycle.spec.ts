import { expect, test } from "@playwright/test";
import { openProjectBoard } from "../../scripts/scenarios/harness/project-board-ui";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../scripts/scenarios/scenarios/board-dense";
import { openBoardPageFromCard } from "./support/open-board-page";
import { invokeIpc } from "./support/editor-scenario";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { fileSource } from "../../src/shared/file-resources";

test("opening Pages preserves their committed document heads until a content edit", async () => {
  test.setTimeout(120_000);
  await withElectronScenario(
    { label: "page-open-without-edit", scenarioId: BOARD_DENSE_SCENARIO_ID },
    async ({ page, seed, manifest }) => {
      if (!manifest) throw new Error("Page lifecycle scenario was not materialized");
      const projectId = manifest.projectId;
      const imagePageId = manifest.pageIdsByKey.keyboardPaths!;
      const fileId = createUuidV7();
      await seed.createLibraryFile({
        projectId,
        operationId: createUuidV7(),
        fileId,
        defaultName: "message.gif",
        mimeType: "image/gif",
        // A Uint8Array crosses the renderer bridge as bytes; a Node Buffer does not.
        bytes: new Uint8Array(Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64")),
      });
      await seed.replaceOwnedDocument({
        projectId,
        pageId: imagePageId,
        operationId: createUuidV7(),
        mutationId: createUuidV7(),
        clientSessionId: createUuidV7(),
        markdown: `A message with an image\n\n![Image](${fileSource(fileId)})`,
      });
      const readHead = async (pageId: string) => {
        const detail = await invokeIpc(page, "pages:detail:get", projectId, pageId);
        if (!detail.ok) throw new Error(detail.error.message);
        return detail.value.page.documentHeadSeq;
      };
      await page.getByRole("button", { name: "Open Dense Board", exact: true }).click();
      await openProjectBoard(page);
      for (const { pageId, title, image } of [
        { pageId: manifest.pageIdsByKey.emptyBrief!, title: "Empty brief", image: false },
        {
          pageId: manifest.pageIdsByKey.offlineRecovery!,
          title: "Clarify offline recovery copy",
          image: false,
        },
        { pageId: imagePageId, title: "Review keyboard paths", image: true },
      ]) {
        const before = await readHead(pageId);
        await openBoardPageFromCard({
          page,
          card: page.locator(`[data-board-uuid-v7="${pageId}"]`),
          tabName: title,
        });
        const editor = page
          .getByRole("tabpanel", { name: new RegExp(`${title}$`) })
          .locator('.nfm-editor .ProseMirror[contenteditable="true"]');
        await expect(editor).toBeVisible();
        if (image) {
          await expect
            .poll(() =>
              editor.locator("img").evaluate((element: HTMLImageElement) => element.naturalWidth),
            )
            .toBe(1);
        }
        // Observe beyond the Provider's bounded update-batching window.
        await page.waitForTimeout(750);
        expect(await readHead(pageId)).toBe(before);
      }
      const editor = page
        .getByRole("tabpanel", { name: /Review keyboard paths$/ })
        .locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      const beforeEdit = await readHead(imagePageId);
      const paragraph = editor.locator(
        '.bn-block-content[data-content-type="paragraph"] .bn-inline-content',
      );
      await paragraph.click();
      await expect(editor).toBeFocused();
      // Cmd+Right at a paragraph boundary can select the following atomic image.
      await editor.press(process.platform === "darwin" ? "Control+e" : "End");
      await editor.pressSequentially(" edited");
      await expect(paragraph).toHaveText("A message with an image edited");
      await expect.poll(() => readHead(imagePageId)).toBeGreaterThan(beforeEdit);
      await expect
        .poll(async () => (await seed.readPage(projectId, imagePageId)).descriptionPreview)
        .toBe("A message with an image edited Image");
    },
  );
});

test("keeps Page description editing and history live across creation and retained view remounts", async () => {
  test.setTimeout(120_000);
  await withElectronScenario(
    { label: "editor-resource-lifetimes", scenarioId: BOARD_DENSE_SCENARIO_ID },
    async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const mod = process.platform === "darwin" ? "Meta" : "Control";
      await page.getByRole("button", { name: "Open Dense Board", exact: true }).click();
      await openProjectBoard(page);
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
