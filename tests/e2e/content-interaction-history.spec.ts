import { expect, test } from "@playwright/test";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  createConvergenceBoardPage,
  createConvergenceProject,
  requireString,
  seedConvergenceDocument,
} from "./support/editor-scenario";
import { dragBlockFromEditorWithMouse } from "./support/drag-block-with-mouse";
import { openBoardPageFromCard } from "./support/open-board-page";

test("undoes native promotion immediately and interleaves editor changes in interaction order", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({ label: "content-interaction-history" });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  try {
    const page = await harness.launch();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const project = await createConvergenceProject(
      page,
      "Interaction history",
      harness.profile.initialProjectsDirectory,
    );
    const target = await createConvergenceBoardPage(page, project, "Drop anchor", "Anchor Page");
    const source = await createConvergenceBoardPage(page, project, "History source", "Source Page");
    const seeded = await seedConvergenceDocument(
      page,
      project,
      source,
      "Promoted block\nIndependent text",
    );
    await page.getByRole("button", { name: "Open Interaction history", exact: true }).click();
    await page.getByRole("tab", { name: "Project Home" }).waitFor();
    const triage = page.locator('[data-board-column-root][data-board-column-id="triage"]');
    await openBoardPageFromCard({
      page,
      card: triage.locator(`[data-board-uuid-v7="${source.pageId}"]`),
      tabName: "History source",
    });
    const editor = page.getByRole("tabpanel", { name: /History source$/ }).locator(".nfm-editor");
    const surface = editor.locator('.ProseMirror[contenteditable="true"]');
    const dropped = surface.locator(`.bn-block[data-id="${seeded.blockIds[0]}"]`);
    const independentText = surface
      .locator(`.bn-block[data-id="${seeded.blockIds[1]}"]`)
      .locator(":scope > .bn-block-content .bn-inline-content");
    await independentText.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await page.keyboard.type(" older");
    await expect(independentText).toHaveText("Independent text older");

    await dragBlockFromEditorWithMouse({
      page,
      sourceBlock: dropped,
      sourceEditor: editor,
      target: triage.locator(`[data-board-uuid-v7="${target.pageId}"]`),
      expectedFeedback: page.locator('[data-board-drop-indicator="true"]'),
    });
    const created = triage.getByRole("article", { name: "Drag Promoted block", exact: true });
    await expect(created).toHaveCount(1);
    await expect(dropped).toHaveCount(0);
    const promotedPageId = requireString(
      await created.getAttribute("data-board-uuid-v7"),
      "Promoted Page id",
    );
    const promoted = triage.locator(`[data-board-uuid-v7="${promotedPageId}"]`);

    // The committed projection is the only wait: no pointer, focus, or selection
    // repair may choose a different history owner between native drop and Undo.
    await page.keyboard.press(`${modifier}+Z`);
    await expect(dropped).toBeVisible();
    await expect(promoted).toHaveCount(0);
    await expect(independentText).toHaveText("Independent text older");
    await page.keyboard.press(`${modifier}+Shift+Z`);
    await expect(promoted).toBeVisible();
    await expect(dropped).toHaveCount(0);
    await expect(created).toHaveAttribute("data-board-uuid-v7", promotedPageId);

    await independentText.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await page.keyboard.type(" newer");
    await expect(independentText).toHaveText("Independent text older newer");
    await page.keyboard.press(`${modifier}+Z`);
    await expect(independentText).toHaveText("Independent text older");
    await expect(promoted).toBeVisible();
    await page.keyboard.press(`${modifier}+Z`);
    await expect(dropped).toBeVisible();
    await expect(promoted).toHaveCount(0);
    await expect(independentText).toHaveText("Independent text older");
    await page.keyboard.press(`${modifier}+Z`);
    await expect(independentText).toHaveText("Independent text");

    await page.keyboard.press(`${modifier}+Shift+Z`);
    await expect(independentText).toHaveText("Independent text older");
    await page.keyboard.press(`${modifier}+Shift+Z`);
    await expect(promoted).toBeVisible();
    await expect(dropped).toHaveCount(0);
    await page.keyboard.press(`${modifier}+Shift+Z`);
    await expect(independentText).toHaveText("Independent text older newer");
    await expect(created).toHaveAttribute("data-board-uuid-v7", promotedPageId);
    expect(errors).toEqual([]);
  } finally {
    await harness.close();
  }
});
