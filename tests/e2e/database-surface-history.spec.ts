import { expect, test } from "@playwright/test";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  createConvergenceBoardPage,
  createConvergenceListView,
  createConvergenceProject,
  invokeIpc,
  requireIpcValue,
  requireString,
  seedConvergenceDocument,
} from "./support/editor-scenario";
import { dragBlockFromEditorWithMouse } from "./support/drag-block-with-mouse";
import { dragListRowWithMouse } from "./support/drag-list-row-with-mouse";
import { openBoardPageFromCard } from "./support/open-board-page";

/** Exercise the real application menu after its focused-owner capability settles. */
async function invokeHistoryMenu(
  harness: ElectronScenarioHarness,
  direction: "undo" | "redo",
  action: string,
): Promise<void> {
  await expect
    .poll(() =>
      harness.application.evaluate(({ Menu }, command) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById(`edit.${command}`);
        return { label: item?.label, enabled: item?.enabled };
      }, direction),
    )
    .toEqual({ label: `${direction === "undo" ? "Undo" : "Redo"} ${action}`, enabled: true });
  await harness.application.evaluate(({ Menu, BrowserWindow }, direction) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(`edit.${direction}`);
    if (!item?.enabled) throw new Error(`The native ${direction} command is unavailable`);
    item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {});
  }, direction);
}

test("routes Board, List, and editor transfer Undo/Redo to their real surface owners", async () => {
  test.setTimeout(180_000);
  const harness = await ElectronScenarioHarness.create({ label: "database-surface-history" });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  try {
    const page = await harness.launch();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const project = await createConvergenceProject(
      page,
      "Surface history",
      harness.profile.initialProjectsDirectory,
    );
    const first = await createConvergenceBoardPage(page, project, "History first", "First Page");
    await createConvergenceBoardPage(page, project, "History last", "Last Page");
    const source = await createConvergenceBoardPage(page, project, "History source", "Source Page");
    const seeded = await seedConvergenceDocument(
      page,
      project,
      source,
      "Picker history block\nIndependent text\nNative history block",
    );
    const listViewId = await createConvergenceListView(page, project);
    await page.getByRole("button", { name: "Open Surface history", exact: true }).click();
    await page.getByRole("tab", { name: "Project Home" }).waitFor();
    const triage = page.locator('[data-board-column-root][data-board-column-id="triage"]');
    const build = page.locator('[data-board-column-root][data-board-column-id="build"]');
    const card = `[data-board-uuid-v7="${first.pageId}"]`;
    const viewTab = (viewId: string) =>
      page.locator(`[data-database-view-tab-sortable="${viewId}"]`).getByRole("tab");

    await test.step("Board Property callbacks support native-menu Undo and Redo", async () => {
      await expect(triage.locator(card)).toBeVisible();
      await triage
        .locator(card)
        .locator('[data-card-context-menu-trigger="true"]')
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: /Status/ }).click();
      await page.getByRole("option", { name: "Build", exact: true }).click();
      await expect(build.locator(card)).toBeVisible();
      await expect(triage.locator(card)).toHaveCount(0);
      await invokeHistoryMenu(harness, "undo", "Move Pages");
      await expect(triage.locator(card)).toBeVisible();
      await expect(build.locator(card)).toHaveCount(0);
      await invokeHistoryMenu(harness, "redo", "Move Pages");
      await expect(build.locator(card)).toBeVisible();
      await invokeHistoryMenu(harness, "undo", "Move Pages");
      await expect(triage.locator(card)).toBeVisible();
    });

    await test.step("a native List move has a symmetric inverse", async () => {
      await viewTab(listViewId).click();
      const grid = page.getByRole("grid", { name: /List$/ });
      await expect(grid).toBeVisible();
      const rows = grid.locator('[data-list-row="true"][data-database-view-page-id]');
      await expect(rows).toHaveCount(3);
      const order = () =>
        rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-database-view-page-id") ?? ""),
        );
      const before = await order();
      const movedPage = before[0]!;
      await dragListRowWithMouse({
        page,
        sourceRow: grid.locator(
          `[data-list-row="true"][data-database-view-page-id="${movedPage}"]`,
        ),
        targetRow: grid.locator(
          `[data-list-row="true"][data-database-view-page-id="${before[2]}"]`,
        ),
        position: "after",
      });
      const after = [...before.slice(1), movedPage];
      await expect.poll(order).toEqual(after);
      await invokeHistoryMenu(harness, "undo", "Move Pages");
      await expect.poll(order).toEqual(before);
      await invokeHistoryMenu(harness, "redo", "Move Pages");
      await expect.poll(order).toEqual(after);
    });

    await viewTab(project.defaultDatabaseViewId).click();
    await openBoardPageFromCard({
      page,
      card: triage.locator(`[data-board-uuid-v7="${source.pageId}"]`),
      tabName: "History source",
    });
    const editor = page.getByRole("tabpanel", { name: /History source$/ }).locator(".nfm-editor");
    const surface = editor.locator('.ProseMirror[contenteditable="true"]');
    const block = (id: string) => surface.locator(`.bn-block[data-id="${id}"]`);
    const independentText = block(seeded.blockIds[1]!).locator(
      ":scope > .bn-block-content .bn-inline-content",
    );
    await independentText.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await page.keyboard.type(" kept");
    await expect(independentText).toHaveText("Independent text kept");

    await test.step("Move to Database belongs to its source editor, ahead of older typing", async () => {
      const selected = block(seeded.blockIds[0]!);
      await selected.locator(":scope > .bn-block-content").click();
      await page.keyboard.press(`${modifier}+/`);
      await page.getByRole("dialog", { name: "Block actions" }).waitFor();
      await page.getByRole("option", { name: /^Move to/ }).click();
      await page.getByRole("combobox", { name: "Move blocks to" }).waitFor();
      await page
        .locator(
          `[data-nfm-move-to-row-kind="db-column"][data-nfm-move-to-project-id="${project.projectId}"]`,
        )
        .filter({ hasText: "Triage" })
        .click();
      const created = triage.getByRole("article", {
        name: "Drag Picker history block",
        exact: true,
      });
      await expect(created).toHaveCount(1);
      await expect(selected).toHaveCount(0);
      const pageId = await created.getAttribute("data-board-uuid-v7");
      const promoted = triage.locator(`[data-board-uuid-v7="${pageId}"]`);
      await independentText.click();
      await invokeHistoryMenu(harness, "undo", "Move to Database");
      await expect(selected).toBeVisible();
      await expect(promoted).toHaveCount(0);
      await expect(independentText).toHaveText("Independent text kept");
      await invokeHistoryMenu(harness, "redo", "Move to Database");
      await expect(promoted).toHaveAttribute("data-board-uuid-v7", pageId!);
      await expect(selected).toHaveCount(0);
      await expect(independentText).toHaveText("Independent text kept");
    });

    let promotedPageId = "";
    await test.step("native Block-to-Board Drop belongs to the target View", async () => {
      const dropped = block(seeded.blockIds[2]!);
      await dragBlockFromEditorWithMouse({
        page,
        sourceBlock: dropped,
        sourceEditor: editor,
        target: triage.locator(card),
        expectedFeedback: page.locator('[data-board-drop-indicator="true"]'),
      });
      const created = triage.getByRole("article", {
        name: "Drag Native history block",
        exact: true,
      });
      await expect(created).toHaveCount(1);
      await expect(dropped).toHaveCount(0);
      const pageId = await created.getAttribute("data-board-uuid-v7");
      promotedPageId = requireString(pageId, "Promoted Page id");
      const promoted = triage.locator(`[data-board-uuid-v7="${pageId}"]`);
      // Pointer focus on the Board's padding chooses its owner without editing content.
      await page.locator('[data-database-board-scroll="true"]').click({ position: { x: 4, y: 4 } });
      await invokeHistoryMenu(harness, "undo", "Move to Database");
      await expect(dropped).toBeVisible();
      await expect(promoted).toHaveCount(0);
      await invokeHistoryMenu(harness, "redo", "Move to Database");
      await expect(promoted).toHaveAttribute("data-board-uuid-v7", pageId!);
      await expect(dropped).toHaveCount(0);
      await expect(independentText).toHaveText("Independent text kept");
    });

    await test.step("a conflicting Page edit keeps content intact through history reset", async () => {
      const preparePromoted = async () =>
        requireIpcValue<Record<string, unknown>>(
          await invokeIpc(page, "block-document:owned:prepare", project.projectId, promotedPageId),
          "Prepare promoted Page",
        );
      const descriptor = await preparePromoted();
      await seedConvergenceDocument(
        page,
        project,
        {
          pageId: promotedPageId,
          documentId: requireString(descriptor.documentId, "Promoted Document id"),
        },
        "Independent Page edit\nKeep this content",
      );
      const changed = await preparePromoted();
      await invokeHistoryMenu(harness, "undo", "Move to Database");
      const board = page.locator(`[data-database-view-id="${project.defaultDatabaseViewId}"]`);
      await expect(board.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      await expect(board.getByRole("button", { name: "Reset history", exact: true })).toBeVisible();
      const blockedScreenshot = test.info().outputPath("blocked-view-history.png");
      await page.screenshot({ path: blockedScreenshot });
      await test.info().attach("Blocked View history", {
        path: blockedScreenshot,
        contentType: "image/png",
      });
      await board.getByRole("button", { name: "Reset history", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Reset this surface’s history?" });
      await expect(dialog).toBeVisible();
      const confirmationScreenshot = test.info().outputPath("reset-history-confirmation.png");
      await page.screenshot({ path: confirmationScreenshot });
      await test.info().attach("Reset history confirmation", {
        path: confirmationScreenshot,
        contentType: "image/png",
      });
      await dialog.getByRole("button", { name: "Reset history", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(board.getByRole("button", { name: "Reset history", exact: true })).toHaveCount(
        0,
      );
      await expect(triage.locator(`[data-board-uuid-v7="${promotedPageId}"]`)).toBeVisible();
      await expect(block(seeded.blockIds[2]!)).toHaveCount(0);
      const afterReset = await preparePromoted();
      expect({ generation: afterReset.generation, headSeq: afterReset.headSeq }).toEqual({
        generation: changed.generation,
        headSeq: changed.headSeq,
      });
      await expect(independentText).toHaveText("Independent text kept");
    });
    await test.step("a Page dropped into the editor blocks older history without a complete inverse", async () => {
      const sourceCard = triage.locator(card);
      await sourceCard.scrollIntoViewIfNeeded();
      await expect(sourceCard).toHaveAttribute("draggable", "true");
      const sourceBox = await sourceCard.boundingBox();
      const targetBox = await independentText.boundingBox();
      if (!sourceBox || !targetBox) throw new Error("Page-to-editor drag has no layout box");
      const from = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + 8 };
      const to = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height - 2 };
      try {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 12, from.y, { steps: 4 });
        await page.mouse.move(to.x, to.y, { steps: 24 });
        await page.mouse.move(to.x + 1, to.y);
        await page.mouse.move(to.x + 2, to.y);
        await expect(editor.locator("[data-block-transfer-drop-indicator]")).toBeVisible();
      } finally {
        await page.mouse.up();
      }
      await expect(block(first.pageId)).toBeVisible();
      await expect(sourceCard).toHaveCount(0);
      await expect(editor.getByRole("status")).toHaveText(
        "Move Pages here · This transfer has no complete inverse.",
      );
      await independentText.click();
      await page.keyboard.press(`${modifier}+Z`);
      await expect(independentText).toHaveText("Independent text kept");
      await expect(block(first.pageId)).toBeVisible();
      const persisted = requireIpcValue<{ page: Record<string, unknown> }>(
        await invokeIpc(page, "pages:detail:get", project.projectId, first.pageId),
        "Read dropped Page",
      ).page;
      expect(persisted).toMatchObject({
        pageId: first.pageId,
        documentId: first.documentId,
        parent: { kind: "page", pageId: source.pageId },
        plainText: "First Page",
      });
      const screenshot = test.info().outputPath("editor-transfer-history-barrier.png");
      await page.screenshot({ path: screenshot });
      await test.info().attach("Editor transfer history barrier", {
        path: screenshot,
        contentType: "image/png",
      });
    });
    expect(errors).toEqual([]);
  } finally {
    await harness.close();
  }
});
