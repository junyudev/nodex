import { closeWorkbenchSettings, openWorkbenchSettings } from "./support/workbench-settings";
import { managePageFile, pageFilesTree } from "./support/page-files";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Locator } from "@playwright/test";
import { fromMarkdown } from "mdast-util-from-markdown";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../scripts/scenarios/scenarios/board-dense";
import {
  focusBoardDenseUi,
  pageStageBodyEditor,
} from "../../scripts/scenarios/scenarios/board-dense-ui";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAAJElEQVR4nGMwTptJU8QwasGoBaMWjFowasGoBaMWjFowNCwAANObli6VLqqlAAAAAElFTkSuQmCC";
const FILE_IMAGE_BLOCK = '[data-content-type="image"][data-url^="nodex://files/"]';
const primaryShortcut = (key: string): string =>
  `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

/** Opens the quiet Properties and chooses one empty entry, which adds its row with its editor open. */
const chooseEmptyPageProperty = async (stage: Locator, name: string): Promise<void> => {
  const choices = stage.getByRole("group", { name: "Empty properties", exact: true });
  if (!(await choices.isVisible())) {
    await stage.getByRole("button", { name: /\d+ more propert(?:y|ies)/u }).click();
  }
  await choices.getByRole("button", { name, exact: true }).click();
};

test("previews a pasted image above editor chrome and refreshes Files only for placement changes", async () => {
  test.setTimeout(180_000);
  await withElectronScenario(
    {
      label: "page-files-image-paste",
      scenarioId: BOARD_DENSE_SCENARIO_ID,
    },
    async ({ application, page, manifest }) => {
      if (!manifest) throw new Error("board/dense did not materialize");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });
      const stage = await focusBoardDenseUi(page, manifest);
      await expect(stage.getByRole("button", { name: "Add Page Files" })).toHaveCount(0);
      await chooseEmptyPageProperty(stage, "Tags");
      await expect(page.getByPlaceholder("Search options…")).toBeVisible();
      await page.keyboard.press("Escape");
      await chooseEmptyPageProperty(stage, "Files");
      const manager = page.getByRole("dialog", { name: "Page files", exact: true });
      await expect(manager).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(manager).not.toBeVisible();
      const files = stage.getByRole("button", { name: "Add Page Files" });
      await expect(files).toHaveAttribute("aria-busy", "false");

      const filesEmptyX = (await files.getByText("Empty", { exact: true }).boundingBox())?.x;
      const peerEmptyX = (
        await stage
          .getByRole("button", { name: "Edit Tags" })
          .getByText("Empty", { exact: true })
          .boundingBox()
      )?.x;
      if (filesEmptyX === undefined || peerEmptyX === undefined) {
        throw new Error("Page property Empty values have no visible geometry");
      }
      expect(
        Math.abs(filesEmptyX - peerEmptyX),
        `Files Empty x=${filesEmptyX}; Tags Empty x=${peerEmptyX}`,
      ).toBeLessThanOrEqual(1);

      await files.evaluate((element) => {
        const transitions: string[] = [];
        (
          window as typeof window & { __pageFilesBusyTransitions?: string[] }
        ).__pageFilesBusyTransitions = transitions;
        new MutationObserver(() =>
          transitions.push(element.getAttribute("aria-busy") ?? "missing"),
        ).observe(element, { attributes: true, attributeFilter: ["aria-busy"] });
      });
      const filesElement = await files.elementHandle();
      if (!filesElement) throw new Error("Files row is unavailable");

      const editor = pageStageBodyEditor(stage);
      await editor.getByText("Keep Board and Page views convergent.", { exact: true }).click();
      await expect(editor).toBeFocused();
      await page.keyboard.type("x");
      await page.waitForTimeout(800);
      expect(await filesElement.evaluate((element) => element.isConnected)).toBe(true);
      expect(
        await page.evaluate(
          () =>
            (window as typeof window & { __pageFilesBusyTransitions?: string[] })
              .__pageFilesBusyTransitions ?? [],
        ),
      ).not.toContain("true");

      await writeTestClipboardImage(application, PNG_DATA_URL);
      await page.keyboard.press(primaryShortcut("v"));
      const pastedImageBlock = editor.locator(FILE_IMAGE_BLOCK);
      const pastedImage = pastedImageBlock.locator("img");
      await expect(pastedImage).toBeVisible();
      await expect(pastedImage).toHaveAttribute("src", /^blob:/u);
      await expect(stage.getByText("Add image", { exact: true })).toHaveCount(0);
      const tree = await pageFilesTree(stage, 1);
      // With no attachments to set it apart from, the body's own File is listed plainly.
      await expect(tree.getByRole("treeitem")).toHaveCount(1);
      await expect(tree.getByRole("treeitem", { name: "In page" })).toHaveCount(0);

      await pastedImage.click();
      const imageToolbar = page.locator('[role="toolbar"]').filter({
        has: page.getByRole("button", { name: "Download image" }),
      });
      await expect(imageToolbar).toBeVisible();
      const toolbarBounds = await imageToolbar.boundingBox();
      if (!toolbarBounds) throw new Error("Image toolbar has no visible geometry");

      await pastedImage.dblclick();
      const imagePreview = page.getByRole("dialog", { name: "Image preview" });
      await expect(imagePreview).toBeVisible();
      const previewOwnsToolbarPoint = await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest('[data-slot="codex-dialog-content"], [data-slot="codex-dialog-overlay"]') !==
          null,
        {
          x: toolbarBounds.x + toolbarBounds.width / 2,
          y: toolbarBounds.y + toolbarBounds.height / 2,
        },
      );
      expect(previewOwnsToolbarPoint).toBe(true);
      await imagePreview.getByRole("button", { name: "Close image preview" }).click();

      const dialog = await managePageFile(page, tree.getByRole("treeitem"));
      await expect(
        dialog.getByRole("button", { name: /^Preview /u }).locator('[data-file-tab-icon="image"]'),
      ).toBeVisible();
    },
  );
});

test("copies portable File references by default and local blob paths when enabled", async () => {
  test.setTimeout(180_000);
  await withElectronScenario(
    {
      label: "page-files-copy-local-path",
      scenarioId: BOARD_DENSE_SCENARIO_ID,
    },
    async ({ application, page, manifest, profile }) => {
      if (!manifest) throw new Error("board/dense did not materialize");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });
      const stage = await focusBoardDenseUi(page, manifest);
      const editor = pageStageBodyEditor(stage);
      const paragraph = editor.getByText("Keep Board and Page views convergent.", { exact: true });
      await paragraph.click();
      await expect(editor).toBeFocused();
      await writeTestClipboardImage(application, PNG_DATA_URL);
      await page.keyboard.press(primaryShortcut("v"));

      const imageBlock = editor.locator(FILE_IMAGE_BLOCK);
      const image = imageBlock.locator("img");
      await expect(image).toBeVisible();
      const fileReference = await imageBlock.getAttribute("data-url");
      if (!fileReference) throw new Error("Pasted image has no File reference");
      const readCopiedImageSource = async (): Promise<string | undefined> => {
        const text = await application.evaluate(({ clipboard }) => clipboard.readText());
        const [block] = fromMarkdown(text).children;
        const image = block?.type === "paragraph" ? block.children[0] : undefined;
        return image?.type === "image" ? image.url : undefined;
      };

      await image.click();
      await page.keyboard.press(primaryShortcut("c"));
      await expect.poll(readCopiedImageSource).toBe(fileReference);

      await openWorkbenchSettings(page);
      const settings = page.getByTestId("settings-route-shell");
      await settings.getByRole("link", { name: "Editor", exact: true }).click();
      const localPathSwitch = settings.getByRole("switch", {
        name: "Copy file references as local paths",
      });
      await expect(localPathSwitch).toHaveAttribute("aria-checked", "false");
      await localPathSwitch.click();
      await expect(localPathSwitch).toHaveAttribute("aria-checked", "true");
      await closeWorkbenchSettings(page);

      await image.click();
      await page.keyboard.press(primaryShortcut("c"));
      const exportRoot = path.join(profile.nodexHome, "cache", "file-exports");
      await expect(async () => {
        const exportPath = await readCopiedImageSource();
        if (!exportPath) throw new Error("Copied image has no local File path");
        const hashDirectory = path.dirname(exportPath);
        expect(path.dirname(hashDirectory)).toBe(exportRoot);
        expect((await stat(exportPath)).isFile()).toBe(true);
        const bytes = await readFile(exportPath);
        expect(path.basename(hashDirectory)).toBe(createHash("sha256").update(bytes).digest("hex"));
        expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      }).toPass();

      await editor.getByRole("heading", { name: "Rendering contract", exact: true }).click();
      await expect(editor).toBeFocused();
      await page.keyboard.press(primaryShortcut("v"));
      await expect(imageBlock).toHaveCount(2);
    },
  );
});

test("imports native files and folders with canonical identities", async () => {
  test.setTimeout(180_000);
  await withElectronScenario(
    {
      label: "page-files-picker-upload",
      scenarioId: BOARD_DENSE_SCENARIO_ID,
    },
    async ({ application, page, manifest, profile }) => {
      if (!manifest) throw new Error("board/dense did not materialize");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });
      const stage = await focusBoardDenseUi(page, manifest);

      const fixturePaths = [
        path.join(profile.runRoot, "picked-data.json"),
        path.join(profile.runRoot, "picked-reference.md"),
        path.join(profile.runRoot, "picked-report.pdf"),
      ];
      const droppedPath = path.join(profile.runRoot, "dropped-notes.txt");
      const droppedDirectory = path.join(profile.runRoot, "dropped-references");
      await mkdir(path.join(droppedDirectory, "nested"), { recursive: true });
      await Promise.all([
        writeFile(fixturePaths[0]!, '{"seeded":true}\n', "utf8"),
        writeFile(fixturePaths[1]!, "# Picked reference\n\nSeeded Electron upload.", "utf8"),
        writeFile(fixturePaths[2]!, "%PDF-1.4\n% seeded fixture\n", "utf8"),
        writeFile(droppedPath, "Dropped from the native desktop.\n", "utf8"),
        writeFile(path.join(droppedDirectory, "api.md"), "# Dropped API\n", "utf8"),
        writeFile(
          path.join(droppedDirectory, "nested", "schema.json"),
          '{"dropped":true}\n',
          "utf8",
        ),
      ]);
      await application.evaluate(({ dialog }, selectedPaths) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: selectedPaths,
          bookmarks: [],
        });
      }, fixturePaths);

      await chooseEmptyPageProperty(stage, "Files");
      const dialog = page.getByRole("dialog", { name: "Page files" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "New text" })).toHaveCount(0);

      const dropSurface = dialog.locator('[data-page-files-drop-surface="true"]');
      const dropBounds = await dropSurface.boundingBox();
      if (!dropBounds) throw new Error("Files drop surface has no visible geometry");
      const dropPoint = {
        x: dropBounds.x + dropBounds.width / 2,
        y: dropBounds.y + dropBounds.height / 2,
      };
      const dragData = {
        items: [],
        files: [droppedPath, droppedDirectory],
        dragOperationsMask: 1,
      };
      const cdp = await page.context().newCDPSession(page);
      let dropped = false;
      try {
        await cdp.send("Input.dispatchDragEvent", {
          type: "dragEnter",
          ...dropPoint,
          data: dragData,
        });
        await expect(dialog.locator('[data-page-files-drop-indicator="true"]')).toBeVisible();
        await cdp.send("Input.dispatchDragEvent", {
          type: "dragOver",
          ...dropPoint,
          data: dragData,
        });
        await cdp.send("Input.dispatchDragEvent", {
          type: "drop",
          ...dropPoint,
          data: dragData,
        });
        dropped = true;
      } finally {
        if (!dropped) {
          await cdp.send("Input.dispatchDragEvent", {
            type: "dragCancel",
            ...dropPoint,
            data: dragData,
          });
        }
        await cdp.detach();
      }

      await expect(
        dialog
          .getByRole("button", { name: "Preview dropped-notes.txt" })
          .locator('[data-file-tab-icon="document"]'),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Preview dropped-references/api.md" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", {
          name: "Preview dropped-references/nested/schema.json",
        }),
      ).toBeVisible();

      await dialog.getByRole("button", { name: "Add files" }).click();

      await expect(
        dialog
          .getByRole("button", { name: "Preview picked-data.json" })
          .locator('[data-file-tab-icon="json"]'),
      ).toBeVisible();
      await expect(
        dialog
          .getByRole("button", { name: "Preview picked-reference.md" })
          .locator('[data-file-tab-icon="document"]'),
      ).toBeVisible();
      await expect(
        dialog
          .getByRole("button", { name: "Preview picked-report.pdf" })
          .locator('[data-file-tab-icon="pdf"]'),
      ).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: /UUID-v7/u })).toHaveCount(0);

      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      const tree = await pageFilesTree(stage, 6);
      await stage.getByRole("button", { name: /^Hide \d+ propert(?:y|ies)$/u }).click();
      await expect(tree).toBeVisible();
      await expect(tree.getByRole("treeitem")).toHaveCount(8);
      for (const [filePath, kind] of [
        ["dropped-notes.txt", "document"],
        ["dropped-references/api.md", "document"],
        ["dropped-references/nested/schema.json", "json"],
        ["picked-data.json", "json"],
        ["picked-reference.md", "document"],
        ["picked-report.pdf", "pdf"],
      ]) {
        await expect(
          tree
            .getByRole("treeitem", { name: filePath, exact: true })
            .locator(`[data-file-tab-icon="${kind}"]`),
        ).toBeVisible();
      }

      const firstFilePath = "picked-data.json";
      const file = tree.getByRole("treeitem", { name: firstFilePath, exact: true });
      await file.click();
      await expect(page.getByRole("tab", { name: firstFilePath, exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.getByRole("tab", { name: "Unify Database View rendering", exact: true }).click();
      const reopened = await managePageFile(page, file);
      await expect(
        reopened.getByRole("button", { name: `Preview ${firstFilePath}` }),
      ).toHaveAttribute("aria-pressed", "true");
    },
  );
});
import { writeTestClipboardImage } from "./clipboard";
