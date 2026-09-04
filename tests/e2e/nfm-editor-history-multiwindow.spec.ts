import { expect, test, type Page } from "@playwright/test";
import type { PageDetail } from "../../src/shared/page-detail";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  createConvergenceBoardPage,
  createConvergenceProject,
  createConvergenceSubpage,
  invokeIpc,
  requireIpcValue,
  seedConvergenceDocument,
  type ConvergencePage,
} from "./support/editor-scenario";
import { openBoardPageFromCard } from "./support/open-board-page";
import { selectEditorBlockRange } from "./support/select-editor-block-range";

test("two windows retain independent text history after the same Document's structure is restored", async () => {
  test.setTimeout(180_000);
  const harness = await ElectronScenarioHarness.create({ label: "same-document-window-history" });
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const end = process.platform === "darwin" ? "Meta+ArrowRight" : "End";
  try {
    const first = await harness.launch();
    const project = await createConvergenceProject(
      first,
      "Shared Document history",
      harness.profile.initialProjectsDirectory,
    );
    const source = await createConvergenceBoardPage(
      first,
      project,
      "Shared history",
      "Two window history",
    );
    const seed = await seedConvergenceDocument(
      first,
      project,
      source,
      "before\nafter\nsurvivor\nindependent",
    );
    const child = await createConvergenceSubpage(
      first,
      project,
      source,
      "Restored child",
      seed.blockIds[1],
    );
    await seedConvergenceDocument(first, project, child, "retained child content\nchild tail");
    const open = async (window: Page) => {
      await window
        .getByRole("button", { name: "Open Shared Document history", exact: true })
        .click();
      await window.getByRole("tab", { name: "Project Home" }).waitFor();
      await openBoardPageFromCard({
        page: window,
        card: window.locator(`[data-board-uuid-v7="${source.pageId}"]`),
        tabName: "Shared history",
      });
      return window
        .getByRole("tabpanel", { name: /Shared history$/ })
        .locator('.nfm-editor .ProseMirror[contenteditable="true"]');
    };
    const firstEditor = await open(first);
    const opened = harness.application.waitForEvent("window");
    expect(await invokeIpc(first, "window:new", {})).toBe(true);
    const second = await opened;
    await second.waitForURL((url) => url.protocol !== "about:");
    await second.waitForLoadState("domcontentloaded");
    await second.evaluate(() => window.api?.awaitInitialization?.());
    const secondEditor = await open(second);
    const block = (editor: ReturnType<Page["locator"]>, id: string) =>
      editor.locator(`.bn-block[data-id="${id}"]`);
    const text = (editor: ReturnType<Page["locator"]>, id: string) =>
      block(editor, id).locator(":scope > .bn-block-content .bn-inline-content");
    const expectText = async (locator: ReturnType<Page["locator"]>, expected: string) => {
      await expect
        .poll(() =>
          locator.evaluate((element) => {
            const content = element.cloneNode(true) as HTMLElement;
            // Presence labels are decorations, not the shared Document's text.
            for (const cursor of content.querySelectorAll(".bn-collaboration-cursor__base"))
              cursor.remove();
            return content.textContent;
          }),
        )
        .toBe(expected);
    };
    const firstText = text(firstEditor, seed.blockIds[0]!);
    const secondText = text(secondEditor, seed.blockIds[0]!);
    const focusWindow = async (page: Page) => {
      const nativeWindow = await harness.application.browserWindow(page);
      await nativeWindow.evaluate((window) => window.focus());
      await page.bringToFront();
    };
    await focusWindow(first);
    await firstText.click();
    await first.keyboard.press(end);
    await first.keyboard.type(" A-before");
    await expectText(secondText, "before A-before");

    await focusWindow(second);
    const independent = text(secondEditor, seed.blockIds[3]!);
    await independent.click();
    await second.keyboard.press(end);
    await second.keyboard.type(" B-only");
    await expectText(text(firstEditor, seed.blockIds[3]!), "independent B-only");
    await selectEditorBlockRange({
      page: second,
      editor: secondEditor,
      firstBlock: block(secondEditor, seed.blockIds[0]!),
      lastBlock: block(secondEditor, seed.blockIds[1]!),
    });
    await second.keyboard.press(`${mod}+X`);
    await expect(block(firstEditor, child.pageId)).toHaveCount(0);
    await expect(block(secondEditor, child.pageId)).toHaveCount(0);
    await second.keyboard.press(`${mod}+Z`);
    await expect(block(firstEditor, child.pageId)).toBeVisible();
    await expect(block(secondEditor, child.pageId)).toBeVisible();
    const restored = requireIpcValue<{ documentId: string }>(
      await invokeIpc(first, "block-document:owned:prepare", project.projectId, child.pageId),
      "Restored shared Document child",
    );
    expect(restored.documentId).toBe(child.documentId);

    await focusWindow(first);
    await firstText.click();
    await first.keyboard.press(`${mod}+Z`);
    await expectText(firstText, "before");
    await expectText(secondText, "before");
    await expectText(independent, "independent B-only");
    await expect(block(firstEditor, child.pageId)).toBeVisible();
    await first.keyboard.press(`${mod}+Shift+Z`);
    await expectText(firstText, "before A-before");
    await expectText(secondText, "before A-before");
    await expectText(independent, "independent B-only");
    const readPersistedPage = async (pageId: string) =>
      requireIpcValue<PageDetail>(
        await invokeIpc(first, "pages:detail:get", project.projectId, pageId),
        "Read persisted shared history Page",
      ).page;
    await expect
      .poll(() => readPersistedPage(source.pageId))
      .toMatchObject({
        pageId: source.pageId,
        documentId: source.documentId,
        plainText: expect.stringMatching(/before A-before[\s\S]*independent B-only/),
      });
    expect(await readPersistedPage(child.pageId)).toMatchObject({
      pageId: child.pageId,
      documentId: child.documentId,
      parent: { kind: "page", pageId: source.pageId },
      plainText: "retained child content child tail",
    });
  } finally {
    await harness.close();
  }
});

test("cross-window paste supersedes only the source Cut and keeps independent Undo and Redo", async () => {
  test.setTimeout(180_000);
  const harness = await ElectronScenarioHarness.create({ label: "multiwindow-editor-history" });
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const end = process.platform === "darwin" ? "Meta+ArrowRight" : "End";
  try {
    const sourceWindow = await harness.launch();
    const errors: string[] = [];
    sourceWindow.on("pageerror", (error) => errors.push(error.message));
    const project = await createConvergenceProject(
      sourceWindow,
      "Window history",
      harness.profile.initialProjectsDirectory,
    );
    const source = await createConvergenceBoardPage(
      sourceWindow,
      project,
      "Cut source",
      "History source",
    );
    const target = await createConvergenceBoardPage(
      sourceWindow,
      project,
      "Paste target",
      "History target",
    );
    const sourceSeed = await seedConvergenceDocument(
      sourceWindow,
      project,
      source,
      "before\nafter\nsurvivor",
    );
    const child = await createConvergenceSubpage(
      sourceWindow,
      project,
      source,
      "Moved history child",
      sourceSeed.blockIds[1],
    );
    await seedConvergenceDocument(sourceWindow, project, child, "owned content\nowned tail");
    const targetSeed = await seedConvergenceDocument(sourceWindow, project, target, "target\ntail");
    const open = async (window: Page, page: ConvergencePage, title: string) => {
      await window.getByRole("button", { name: "Open Window history", exact: true }).click();
      await window.getByRole("tab", { name: "Project Home" }).waitFor();
      await openBoardPageFromCard({
        page: window,
        card: window.locator(`[data-board-uuid-v7="${page.pageId}"]`),
        tabName: title,
      });
      return window
        .getByRole("tabpanel", { name: new RegExp(`${title}$`) })
        .locator('.nfm-editor .ProseMirror[contenteditable="true"]');
    };
    const sourceEditor = await open(sourceWindow, source, "Cut source");
    const sourceBlock = (id: string) => sourceEditor.locator(`.bn-block[data-id="${id}"]`);
    const survivor = sourceBlock(sourceSeed.blockIds[2]!).locator(
      ":scope > .bn-block-content .bn-inline-content",
    );
    const sourceOwner = sourceBlock(child.pageId);
    await survivor.click();
    await sourceWindow.keyboard.press(end);
    await sourceWindow.keyboard.type(" C-before");
    await expect(survivor).toHaveText("survivor C-before");
    await selectEditorBlockRange({
      page: sourceWindow,
      editor: sourceEditor,
      firstBlock: sourceBlock(sourceSeed.blockIds[0]!),
      lastBlock: sourceBlock(sourceSeed.blockIds[1]!),
    });
    await sourceWindow.keyboard.press(`${mod}+X`);
    await expect(sourceOwner).toHaveCount(0);
    await survivor.click();
    await sourceWindow.keyboard.press(end);
    await sourceWindow.keyboard.type(" B-after");
    await expect(survivor).toHaveText("survivor C-before B-after");

    const opened = harness.application.waitForEvent("window");
    expect(await invokeIpc(sourceWindow, "window:new", {})).toBe(true);
    const targetWindow = await opened;
    targetWindow.on("pageerror", (error) => errors.push(error.message));
    await targetWindow.waitForURL((url) => url.protocol !== "about:");
    await targetWindow.waitForLoadState("domcontentloaded");
    await targetWindow.evaluate(() => window.api?.awaitInitialization?.());
    const targetEditor = await open(targetWindow, target, "Paste target");
    const targetOwner = targetEditor.locator(`.bn-block[data-id="${child.pageId}"]`);
    const targetText = targetEditor.locator(
      `.bn-block[data-id="${targetSeed.blockIds[0]}"] > .bn-block-content .bn-inline-content`,
    );
    await targetText.click();
    await targetWindow.keyboard.press(end);
    await targetWindow.keyboard.press(`${mod}+V`);
    await expect(targetOwner).toBeVisible();
    await expect(sourceOwner).toHaveCount(0);

    // The older Cut must disappear from source history after target consumes it;
    // its surrounding text entries must not be cleared or moved to the target.
    await sourceWindow.bringToFront();
    await survivor.click();
    await sourceWindow.keyboard.press(`${mod}+Z`);
    await expect(survivor).toHaveText("survivor C-before");
    await sourceWindow.keyboard.press(`${mod}+Z`);
    await expect(survivor).toHaveText("survivor");
    await expect(targetOwner).toBeVisible();
    await expect(sourceOwner).toHaveCount(0);

    await targetWindow.bringToFront();
    await targetText.click();
    await targetWindow.keyboard.press(`${mod}+Z`);
    await expect(targetOwner).toHaveCount(0);
    await expect(sourceOwner).toBeVisible();
    const restored = requireIpcValue<{ documentId: string }>(
      await invokeIpc(
        sourceWindow,
        "block-document:owned:prepare",
        project.projectId,
        child.pageId,
      ),
      "Restored cross-window child",
    );
    expect(restored.documentId).toBe(child.documentId);

    await sourceWindow.bringToFront();
    await survivor.click();
    await sourceWindow.keyboard.press(`${mod}+Shift+Z`);
    await expect(survivor).toHaveText("survivor C-before");
    await sourceWindow.keyboard.press(`${mod}+Shift+Z`);
    await expect(survivor).toHaveText("survivor C-before B-after");
    await targetWindow.bringToFront();
    await targetText.click();
    await targetWindow.keyboard.press(`${mod}+Shift+Z`);
    await expect(targetOwner).toBeVisible();
    await expect(sourceOwner).toHaveCount(0);
    await expect(survivor).toHaveText("survivor C-before B-after");
    expect(errors).toEqual([]);
  } finally {
    await harness.close();
  }
});
