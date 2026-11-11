import { expect, test, type Page } from "@playwright/test";
import { openProjectBoard } from "../../scripts/scenarios/harness/project-board-ui";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../scripts/scenarios/scenarios/board-dense";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { invokeIpc } from "./support/editor-scenario";
import { openBoardPageFromCard } from "./support/open-board-page";

const FIRST_PARAGRAPH = "Existing paragraph";
const SECOND_PARAGRAPH = "Following paragraph";
const COMMITTED_TEXT = "你好们";

// CDP keeps Chromium's real marked-text range, including a Backspace inside it.
async function composeWithBackspace(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const settle = async () => {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await page.waitForTimeout(30);
  };
  try {
    for (const text of [
      "n",
      "ni",
      "nih",
      "niha",
      "nihao",
      "nihaom",
      "nihaoma",
      "nihaom",
      "nihaomen",
    ]) {
      await cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      await settle();
    }
    await cdp.send("Input.insertText", { text: COMMITTED_TEXT });
    await settle();
  } finally {
    await cdp.detach();
  }
}

test("Backspace inside an IME composition on a new line keeps and saves the composed text", async () => {
  await withElectronScenario(
    { label: "nfm-ime-composition", scenarioId: BOARD_DENSE_SCENARIO_ID },
    async ({ page, seed, manifest }) => {
      if (!manifest) throw new Error("IME scenario was not materialized");
      const projectId = manifest.projectId;
      const pageId = manifest.pageIdsByKey.keyboardPaths!;
      await seed.replaceOwnedDocument({
        projectId,
        pageId,
        operationId: createUuidV7(),
        mutationId: createUuidV7(),
        clientSessionId: createUuidV7(),
        markdown: `${FIRST_PARAGRAPH}\n\n${SECOND_PARAGRAPH}`,
      });
      const readPreview = async () => {
        const detail = await invokeIpc(page, "pages:detail:get", projectId, pageId);
        if (!detail.ok) throw new Error(detail.error.message);
        return detail.value.page.preview;
      };
      await page.getByRole("button", { name: "Open Dense Board", exact: true }).click();
      await openProjectBoard(page);
      await openBoardPageFromCard({
        page,
        card: page.locator(`[data-board-uuid-v7="${pageId}"]`),
        tabName: "Review keyboard paths",
      });
      const editor = page
        .getByRole("tabpanel", { name: /Review keyboard paths$/ })
        .locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      const paragraphs = editor.locator(
        '.bn-block-content[data-content-type="paragraph"] .bn-inline-content',
      );
      const blockIds = () =>
        editor
          .locator(".bn-block[data-id]")
          .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-id")));
      await expect(paragraphs).toHaveText([FIRST_PARAGRAPH, SECOND_PARAGRAPH]);
      const [firstId, secondId] = await blockIds();

      await paragraphs.first().click();
      await expect(editor).toBeFocused();
      // ProseMirror observes native caret movement through selectionchange.
      // Finish that movement before Enter creates the empty composition Block.
      const caretMovement = await paragraphs.first().evaluateHandle((paragraph) => {
        const controller = new AbortController();
        const settled = new Promise<void>((resolve) => {
          document.addEventListener(
            "selectionchange",
            () => {
              const selection = window.getSelection();
              if (
                !selection?.isCollapsed ||
                selection.anchorNode !== paragraph.firstChild ||
                selection.anchorOffset !== paragraph.textContent?.length
              )
                return;
              resolve();
            },
            { signal: controller.signal },
          );
        });
        return { settled, release: () => controller.abort() };
      });
      try {
        await editor.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
        await caretMovement.evaluate(({ settled }) => settled);
      } finally {
        await caretMovement.evaluate(({ release }) => release());
        await caretMovement.dispose();
      }
      await editor.press("Enter");
      await expect(paragraphs).toHaveText([FIRST_PARAGRAPH, "", SECOND_PARAGRAPH]);
      const newLineId = (await blockIds())[1];

      await composeWithBackspace(page);

      await expect(paragraphs).toHaveText([FIRST_PARAGRAPH, COMMITTED_TEXT, SECOND_PARAGRAPH]);
      expect(await blockIds()).toEqual([firstId, newLineId, secondId]);
      await expect
        .poll(readPreview)
        .toBe(`${FIRST_PARAGRAPH} ${COMMITTED_TEXT} ${SECOND_PARAGRAPH}`);
    },
  );
});
