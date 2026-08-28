import { mkdir, writeFile } from "node:fs/promises";
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

test("pastes an image and refreshes Files only for body placement changes", async () => {
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

      await application.evaluate(({ clipboard, nativeImage }, dataUrl) => {
        clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
      }, PNG_DATA_URL);
      await page.keyboard.press(primaryShortcut("v"));

      const pastedImageBlock = stage
        .locator('[data-content-type="image"][data-url^="nodex://files/"]')
        .last();
      const pastedImage = pastedImageBlock.locator("img");
      await expect(pastedImage).toBeVisible({ timeout: 15_000 });
      await expect(pastedImage).toHaveAttribute("src", /^data:image\/png;base64,/u);
      await expect(stage.getByText("Add image", { exact: true })).toHaveCount(0);
      await expect(stage.locator('[data-page-file-chip="true"]')).toHaveCount(0);

      const inPageSummary = stage.getByRole("button", {
        name: "Open 1 File shown in Page",
      });
      await expect(inPageSummary).toHaveText("1 in page");
      await inPageSummary.click();

      const dialog = page.getByRole("dialog", { name: "Files" });
      await expect(dialog.getByRole("button", { name: "In page · 1" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expect(
        dialog.getByRole("button", { name: /^Preview /u }).locator('[data-file-tab-icon="image"]'),
      ).toBeVisible();
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
      const dialog = page.getByRole("dialog", { name: "Files" });
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

      await expect(dialog.getByText("dropped-notes.txt", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(dialog.getByText("dropped-references/api.md", { exact: true })).toBeVisible();
      await expect(
        dialog.getByText("dropped-references/nested/schema.json", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog
          .getByRole("button", { name: "Preview dropped-notes.txt" })
          .locator('[data-file-tab-icon="document"]'),
      ).toBeVisible();

      await dialog.getByRole("button", { name: "Add files" }).click();

      await expect(dialog.getByText("picked-reference.md", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
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
      const preview = page.getByRole("dialog", { name: firstFilePath });
      await expect(preview).toBeVisible();
      await expect(preview.locator("[data-file-tab-icon]").first()).toBeVisible();
    },
  );
});
