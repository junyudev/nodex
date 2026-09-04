import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Locator } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../scripts/scenarios/scenarios/board-dense";
import { focusBoardDenseUi } from "../../scripts/scenarios/scenarios/board-dense-ui";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const primaryShortcut = (key: string): string =>
  `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

const revealQuietPageProperties = async (stage: Locator): Promise<void> => {
  const moreProperties = stage.getByRole("button", { name: /\d+ more propert(?:y|ies)/u });
  await expect(moreProperties).toBeVisible();
  await moreProperties.click();
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
      await focusBoardDenseUi(page, manifest);

      const stage = page.locator('[data-page-stage-surface="true"]:visible');
      await expect(stage.getByRole("button", { name: "Add Page Files" })).toHaveCount(0);
      await revealQuietPageProperties(stage);
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

      const editor = stage.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      await editor.click();
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

      const pastedImageBlock = stage
        .locator('[data-content-type="image"][data-url^="nodex://files/"]')
        .last();
      const pastedImage = pastedImageBlock.locator("img");
      await expect(pastedImage).toBeVisible({ timeout: 15_000 });
      await expect(pastedImage).toHaveAttribute("src", /^blob:/u);
      await expect(stage.getByText("Add image", { exact: true })).toHaveCount(0);
      await expect(stage.locator('[data-page-file-chip="true"]')).toHaveCount(0);

      await pastedImageBlock.click();
      const imageToolbar = page.locator('[role="toolbar"]').filter({
        has: page.getByRole("button", { name: "Download image" }),
      });
      await expect(imageToolbar).toBeVisible();
      const toolbarBounds = await imageToolbar.boundingBox();
      if (!toolbarBounds) throw new Error("Image toolbar has no visible geometry");

      await pastedImageBlock.dblclick();
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

      const inPageSummary = stage.getByRole("button", {
        name: "Open 1 File shown in Page",
      });
      await expect(inPageSummary).toHaveText("1 in page");
      await inPageSummary.click();

      const dialog = page.getByRole("dialog", { name: "Page files" });
      await expect(dialog).toBeVisible();
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
      await focusBoardDenseUi(page, manifest);

      const stage = page.locator('[data-page-stage-surface="true"]:visible');
      const editor = stage.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      await editor.click();
      await writeTestClipboardImage(application, PNG_DATA_URL);
      await page.keyboard.press(primaryShortcut("v"));

      const imageBlock = stage
        .locator('[data-content-type="image"][data-url^="nodex://files/"]')
        .last();
      await expect(imageBlock.locator("img")).toBeVisible({ timeout: 15_000 });
      await imageBlock.click();
      await page.keyboard.press(primaryShortcut("c"));
      await expect
        .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
        .toMatch(/nodex:\/\/files\//u);

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const localPathSwitch = page.getByRole("switch", {
        name: "Copy file references as local paths",
      });
      await expect(localPathSwitch).toHaveAttribute("aria-checked", "false");
      await localPathSwitch.click();
      await expect(localPathSwitch).toHaveAttribute("aria-checked", "true");
      await page.getByRole("button", { name: "Back to app" }).click();

      await imageBlock.click();
      await page.keyboard.press(primaryShortcut("c"));
      await expect
        .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
        .toMatch(/\/cache\/file-exports\/[0-9a-f]{64}\.png/u);
      const resolvedText = await application.evaluate(({ clipboard }) => clipboard.readText());
      const blobPath = resolvedText.match(
        /(\/[^\n()<>]*\/cache\/file-exports\/[0-9a-f]{64}\.png)/u,
      )?.[1];
      if (!blobPath) throw new Error(`Copied text has no local Blob path: ${resolvedText}`);
      expect(path.dirname(blobPath)).toBe(path.join(profile.nodexHome, "cache", "file-exports"));
      expect((await stat(blobPath)).isFile()).toBe(true);
      const bytes = await readFile(blobPath);
      expect(path.basename(blobPath)).toBe(
        `${createHash("sha256").update(bytes).digest("hex")}.png`,
      );

      const imageBlocks = stage.locator('[data-content-type="image"][data-url^="nodex://files/"]');
      const imageBlockCount = await imageBlocks.count();
      await editor.click();
      await page.keyboard.press(primaryShortcut("v"));
      await expect(imageBlocks).toHaveCount(imageBlockCount + 1);
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
      await focusBoardDenseUi(page, manifest);

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

      const stage = page.locator('[data-page-stage-surface="true"]:visible');
      await revealQuietPageProperties(stage);
      await stage.getByRole("button", { name: "Add Page Files" }).click();
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
      ).toBeVisible({ timeout: 15_000 });
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
      ).toBeVisible({ timeout: 15_000 });
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
      await stage.getByRole("button", { name: "Hide 1 property" }).click();
      await expect(stage.locator('[data-page-file-chip="true"]')).toHaveCount(2);
      await expect(stage.getByRole("button", { name: "Open 4 more Page Files" })).toBeVisible();
      await expect(stage.locator('[data-page-file-chip="true"] [data-file-tab-icon]')).toHaveCount(
        2,
      );

      const firstFileChip = stage.locator('[data-page-file-chip="true"]').first();
      const firstFilePath = (await firstFileChip.textContent())?.trim();
      if (!firstFilePath) throw new Error("Page File chip has no visible path");
      await firstFileChip.click();
      const reopened = page.getByRole("dialog", { name: "Page files" });
      await expect(reopened).toBeVisible();
      await expect(
        reopened.getByRole("button", { name: `Preview ${firstFilePath}` }),
      ).toHaveAttribute("aria-pressed", "true");
    },
  );
});
import { writeTestClipboardImage } from "./clipboard";
