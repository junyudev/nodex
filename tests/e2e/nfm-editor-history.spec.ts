import { expect, test } from "@playwright/test";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  createConvergenceBoardPage,
  createConvergenceProject,
  createConvergenceSubpage,
  invokeIpc,
  requireIpcValue,
  seedConvergenceDocument,
} from "./support/editor-scenario";
import { openBoardPageFromCard } from "./support/open-board-page";
import { selectEditorBlockRange } from "./support/select-editor-block-range";

test("undoes later typing before a native Subpage cut and restores the same owned Document", async () => {
  test.setTimeout(180_000);
  const harness = await ElectronScenarioHarness.create({ label: "chronological-editor-history" });
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  try {
    const page = await harness.launch();
    const menuLabel = (direction: "undo" | "redo") =>
      harness.application.evaluate(
        ({ Menu }, command) => Menu.getApplicationMenu()?.getMenuItemById(`edit.${command}`)?.label,
        direction,
      );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const project = await createConvergenceProject(
      page,
      "Chronological history",
      harness.profile.initialProjectsDirectory,
    );
    const source = await createConvergenceBoardPage(
      page,
      project,
      "History source",
      "History fixture",
    );
    const seeded = await seedConvergenceDocument(page, project, source, "before\nafter\nsurvivor");
    const child = await createConvergenceSubpage(
      page,
      project,
      source,
      "History child",
      seeded.blockIds[1],
    );
    await seedConvergenceDocument(page, project, child, "owned content\nowned tail");
    await page.getByRole("button", { name: "Open Chronological history", exact: true }).click();
    await page.getByRole("tab", { name: "Project Home" }).waitFor();
    const board = page.locator('[data-board-column-root][data-board-column-id="triage"]');
    await openBoardPageFromCard({
      page,
      card: board.locator(`[data-board-uuid-v7="${source.pageId}"]`),
      tabName: "History source",
    });
    const editor = page
      .getByRole("tabpanel", { name: /History source$/ })
      .locator('.nfm-editor .ProseMirror[contenteditable="true"]');
    const block = (id: string) => editor.locator(`.bn-block[data-id="${id}"]`);
    const owner = block(child.pageId);
    await expect(owner).toBeVisible();
    await selectEditorBlockRange({
      page,
      editor,
      firstBlock: block(seeded.blockIds[0]),
      lastBlock: block(seeded.blockIds[1]),
    });
    await page.keyboard.press(`${mod}+X`);
    await expect(owner).toHaveCount(0);
    const survivor = block(seeded.blockIds[2]).locator(
      ":scope > .bn-block-content .bn-inline-content",
    );
    await survivor.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await page.keyboard.type(" B-later");
    await expect(survivor).toHaveText("survivor B-later");
    await expect.poll(() => menuLabel("undo")).toBe("Undo Edit Text");
    await page.keyboard.press(`${mod}+Z`);
    await expect(survivor).toHaveText("survivor");
    await expect(owner).toHaveCount(0);
    await expect.poll(() => menuLabel("undo")).toBe("Undo Cut Blocks");
    await page.keyboard.press(`${mod}+Z`);
    await expect(owner).toBeVisible();
    await expect.poll(() => menuLabel("redo")).toBe("Redo Cut Blocks");
    const restored = requireIpcValue<{ documentId: string }>(
      await invokeIpc(page, "block-document:owned:prepare", project.projectId, child.pageId),
      "Restored child",
    );
    expect(restored.documentId).toBe(child.documentId);
    await page.keyboard.press(`${mod}+Shift+Z`);
    await expect(owner).toHaveCount(0);
    await page.keyboard.press(`${mod}+Shift+Z`);
    await expect(survivor).toHaveText("survivor B-later");
    // Chromium Undo and the explicit application-menu Redo both reach the
    // focused owner without relying on a DOM keydown.
    await survivor.click();
    const window = await harness.application.browserWindow(page);
    await window.evaluate((nativeWindow) => nativeWindow.webContents.undo());
    await expect(survivor).toHaveText("survivor");
    await harness.application.evaluate(({ Menu, BrowserWindow }) => {
      const command = Menu.getApplicationMenu()?.getMenuItemById("edit.redo");
      if (!command) throw new Error("The native Redo command is missing");
      command.click(command, BrowserWindow.getFocusedWindow() ?? undefined, {});
    });
    await expect(survivor).toHaveText("survivor B-later");
    expect(errors).toEqual([]);
  } finally {
    await harness.close();
  }
});
