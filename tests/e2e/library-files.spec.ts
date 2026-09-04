import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  LIBRARY_FILES_PAGE_A_KEY,
  LIBRARY_FILES_PAGE_B_KEY,
  LIBRARY_FILES_SCENARIO_ID,
  LIBRARY_FILES_SHARED_FILE_KEY,
  LIBRARY_FILES_UNUSED_FILE_KEY,
} from "../../scripts/scenarios/scenarios/library-files";
import {
  focusLibraryFilesProjectHome,
  openLibraryFilesPage,
} from "../../scripts/scenarios/scenarios/library-files-ui";
import type { IpcApi } from "../../src/shared/ipc-api";
import type { LibraryPageFileInventory } from "../../src/shared/library-files";

const UPDATED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlFkAAAAASUVORK5CYII=";

const primaryShortcut = (key: string): string =>
  `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

const invokeIpc = async <Channel extends keyof IpcApi>(
  page: Page,
  channel: Channel,
  ...args: IpcApi[Channel]["args"]
): Promise<IpcApi[Channel]["result"]> =>
  (await page.evaluate(
    async ({ targetChannel, targetArgs }) => {
      const api = (
        window as unknown as {
          api?: { invoke(channel: string, ...values: unknown[]): Promise<unknown> };
        }
      ).api;
      if (!api) throw new Error("Nodex preload API is unavailable");
      return await api.invoke(targetChannel, ...(targetArgs as unknown[]));
    },
    { targetChannel: channel as string, targetArgs: args as unknown[] },
  )) as IpcApi[Channel]["result"];

const readPageFiles = async (
  page: Page,
  projectId: string,
  pageId: string,
): Promise<LibraryPageFileInventory> => {
  const result = await invokeIpc(
    page,
    "library-module:read",
    { kind: "project", projectId },
    { read: { mode: "page_file_inventory", page_id: pageId, limit: 100 } },
  );
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.value.kind !== "page_file_inventory") {
    throw new Error("Page Files returned an unexpected value");
  }
  return result.value.value.value;
};

const openLibraryFiles = async (page: Page): Promise<void> => {
  await page.keyboard.press(primaryShortcut("K"));
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await page.locator('input[aria-label="Command palette search"]:visible').fill("Library files");
  const command = page.getByRole("option", { name: /Library files/u }).first();
  await expect(command).toBeVisible();
  await command.click();
  await expect(page.getByRole("dialog", { name: "Library files" })).toBeVisible();
};

const openPageFileDialog = async (page: Page, pageId: string, pathLabel: string): Promise<void> => {
  const stage = page.locator(`[data-page-stage-page-id="${pageId}"]:visible`);
  const moreProperties = stage.getByRole("button", { name: /\d+ more propert(?:y|ies)/u });
  if (await moreProperties.isVisible().catch(() => false)) {
    await moreProperties.evaluate((element) => (element as HTMLElement).click());
  }
  const pathButton = stage.getByRole("button", { name: new RegExp(pathLabel, "u") }).first();
  if ((await pathButton.count()) > 0) {
    await pathButton.click();
  } else {
    await stage.getByRole("button", { name: /Open \d+ Files? shown in Page/u }).click();
  }
  await expect(page.getByRole("dialog", { name: "Page files" })).toBeVisible();
};

test("manages independent Library Files and replaces only one Page entry", async () => {
  test.setTimeout(180_000);
  await withElectronScenario(
    { label: "library-files-management", scenarioId: LIBRARY_FILES_SCENARIO_ID },
    async ({ application, page, manifest, profile }) => {
      if (!manifest) throw new Error("library/files did not materialize");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });
      await focusLibraryFilesProjectHome(page, manifest);
      await openLibraryFiles(page);

      const dialog = page.getByRole("dialog", { name: "Library files" });
      await expect(dialog.getByText("shared.png", { exact: true }).first()).toBeVisible();
      await expect(dialog.getByText("unused-notes.txt", { exact: true }).first()).toBeVisible();
      await dialog.getByRole("button", { name: "unused", exact: true }).click();
      await expect(dialog.getByText("unused-notes.txt", { exact: true }).first()).toBeVisible();
      await expect(dialog.getByText("shared.png", { exact: true })).toHaveCount(0);

      await dialog.getByText("unused-notes.txt", { exact: true }).first().click();
      await dialog.getByRole("button", { name: "Trash", exact: true }).click();
      await expect(page.getByText("File moved to Trash", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "trash", exact: true }).click();
      await expect(dialog.getByText("unused-notes.txt", { exact: true }).first()).toBeVisible();
      await dialog.getByRole("button", { name: "Restore", exact: true }).click();
      await expect(page.getByText("File restored", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "all", exact: true }).click();
      await dialog.getByText("shared.png", { exact: true }).first().click();
      await expect(dialog.getByRole("button", { name: /Update shared content/u })).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Shared image A", exact: true }),
      ).toBeVisible();
      await dialog.screenshot({ path: test.info().outputPath("library-files.png") });
      await dialog.getByRole("button", { name: "Copy v1 as independent File" }).focus();
      await page.keyboard.press("Tab");
      await expect(
        dialog.getByRole("button", { name: "File sharing and retention" }),
      ).toBeFocused();
      const fileInfo = page.getByRole("tooltip");
      await expect(fileInfo).toContainText("Page references follow shared updates");
      await expect(fileInfo).toContainText("before moving this File to Trash");
      await dialog.screenshot({ path: test.info().outputPath("file-info.png") });
      await dialog.getByRole("button", { name: "Shared image A", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page.locator(
          `[data-page-stage-page-id="${manifest.pageIdsByKey[LIBRARY_FILES_PAGE_A_KEY]}"]:visible`,
        ),
      ).toBeVisible();

      const pageAId = manifest.pageIdsByKey[LIBRARY_FILES_PAGE_A_KEY];
      const pageBId = manifest.pageIdsByKey[LIBRARY_FILES_PAGE_B_KEY];
      const sharedFileId = manifest.entityIdsByKey?.[LIBRARY_FILES_SHARED_FILE_KEY];
      const unusedFileId = manifest.entityIdsByKey?.[LIBRARY_FILES_UNUSED_FILE_KEY];
      if (!pageAId || !pageBId || !sharedFileId || !unusedFileId) {
        throw new Error("library/files manifest is incomplete");
      }
      const [beforeA, beforeB] = await Promise.all([
        readPageFiles(page, manifest.projectId, pageAId),
        readPageFiles(page, manifest.projectId, pageBId),
      ]);
      expect(beforeA.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            logical_path: "assets/shared.png",
            body_count: 1,
            file: expect.objectContaining({ file_id: sharedFileId }),
          }),
        ]),
      );
      expect(beforeB.files[0]).toMatchObject({
        logical_path: "references/shared.png",
        body_count: 1,
        file: { file_id: sharedFileId },
      });

      await openLibraryFilesPage(page, manifest, LIBRARY_FILES_PAGE_A_KEY, "Shared image A");
      await openPageFileDialog(page, pageAId, "assets/shared.png");
      const initialPageFiles = page.getByRole("dialog", { name: "Page files" });
      await expect(
        initialPageFiles
          .getByRole("region", { name: "In page" })
          .getByRole("button", { name: "Preview assets/shared.png" }),
      ).toBeVisible();
      await expect(initialPageFiles.getByRole("region", { name: "Attachments" })).toHaveCount(0);
      const replacementPath = path.join(profile.runRoot, "page-a-local.png");
      await writeFile(replacementPath, Buffer.from(UPDATED_PNG_BASE64, "base64"));
      const chooserPromise = page.waitForEvent("filechooser");
      await page
        .getByRole("dialog", { name: "Page files" })
        .getByRole("button", { name: "Replace path entry…" })
        .click();
      await (await chooserPromise).setFiles(replacementPath);
      await expect(
        page.getByText("This Page entry now uses an independent File", { exact: true }),
      ).toBeVisible();

      const [afterA, afterB] = await Promise.all([
        readPageFiles(page, manifest.projectId, pageAId),
        readPageFiles(page, manifest.projectId, pageBId),
      ]);
      const pageAEntry = afterA.files.find((item) => item.logical_path === "assets/shared.png");
      const pageABody = afterA.files.find((item) => item.file.file_id === sharedFileId);
      expect(afterA.total).toBe(2);
      expect(pageAEntry?.file.file_id).not.toBe(sharedFileId);
      expect(pageAEntry?.body_count).toBe(0);
      expect(pageABody).toMatchObject({ logical_path: null, body_count: 1 });
      expect(afterB).toEqual(beforeB);
      expect(unusedFileId).not.toBe(pageAEntry?.file.file_id);
      const pageFilesDialog = page.getByRole("dialog", { name: "Page files" });
      await expect(
        pageFilesDialog
          .getByRole("region", { name: "Attachments" })
          .getByRole("button", { name: "Preview assets/shared.png" }),
      ).toBeVisible();
      await expect(
        pageFilesDialog
          .getByRole("region", { name: "In page" })
          .getByRole("button", { name: "Preview shared.png" }),
      ).toBeVisible();
      await pageFilesDialog.screenshot({ path: test.info().outputPath("page-files.png") });
      await pageFilesDialog.getByRole("button", { name: "Remove Page path" }).focus();
      await page.keyboard.press("Tab");
      await expect(
        pageFilesDialog.getByRole("button", { name: "Page File paths and content" }),
      ).toBeFocused();
      await expect(page.getByRole("tooltip")).toContainText(
        "Removing a path keeps the Library File",
      );
      await expect(page.getByRole("tooltip")).toContainText(
        "Existing Page content and other Pages stay unchanged",
      );
      await pageFilesDialog.screenshot({ path: test.info().outputPath("page-file-info.png") });
      await pageFilesDialog.getByRole("button", { name: "Browse Library" }).click();
      const picker = page.getByRole("dialog", { name: "Add existing File" });
      await expect(picker).toBeVisible();
      await expect(pageFilesDialog).toHaveCount(0);
      await picker.getByText("unused-notes.txt", { exact: true }).first().click();
      await picker.getByRole("textbox", { name: "Path in Page" }).fill("notes/attached.txt");
      await picker.screenshot({ path: test.info().outputPath("file-picker.png") });
      await picker.getByRole("button", { name: "Add to Page" }).click();
      await expect(page.getByText("File added to Page", { exact: true })).toBeVisible();
      const attached = await readPageFiles(page, manifest.projectId, pageAId);
      expect(attached.files.find((item) => item.file.file_id === unusedFileId)?.logical_path).toBe(
        "notes/attached.txt",
      );
    },
  );
});

test("updates every shared placement and restores one Page from its exact File history", async () => {
  test.setTimeout(180_000);
  await withElectronScenario(
    { label: "library-files-history", scenarioId: LIBRARY_FILES_SCENARIO_ID },
    async ({ application, page, manifest, profile }) => {
      if (!manifest) throw new Error("library/files did not materialize");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });
      const pageAId = manifest.pageIdsByKey[LIBRARY_FILES_PAGE_A_KEY];
      const pageBId = manifest.pageIdsByKey[LIBRARY_FILES_PAGE_B_KEY];
      const sharedFileId = manifest.entityIdsByKey?.[LIBRARY_FILES_SHARED_FILE_KEY];
      if (!pageAId || !pageBId || !sharedFileId) {
        throw new Error("library/files manifest is incomplete");
      }
      await focusLibraryFilesProjectHome(page, manifest);
      const before = await readPageFiles(page, manifest.projectId, pageAId);
      const firstVersionEtag = before.files[0]?.file.blob_etag;
      if (!firstVersionEtag) throw new Error("Shared File has no first-version hash");

      await openLibraryFilesPage(page, manifest, LIBRARY_FILES_PAGE_A_KEY, "Shared image A");
      const pageAStage = page.locator(`[data-page-stage-page-id="${pageAId}"]:visible`);
      await expect(pageAStage.locator('[data-content-type="image"] img')).toBeVisible();
      await openLibraryFilesPage(page, manifest, LIBRARY_FILES_PAGE_B_KEY, "Shared image B");
      const pageBStage = page.locator(`[data-page-stage-page-id="${pageBId}"]:visible`);
      await expect(pageBStage.locator('[data-content-type="image"] img')).toBeVisible();

      await openLibraryFiles(page);
      const dialog = page.getByRole("dialog", { name: "Library files" });
      await dialog.getByText("shared.png", { exact: true }).first().click();
      const updatedPath = path.join(profile.runRoot, "shared-v2.png");
      await writeFile(updatedPath, Buffer.from(UPDATED_PNG_BASE64, "base64"));
      const chooserPromise = page.waitForEvent("filechooser");
      await dialog.getByRole("button", { name: /Update shared content/u }).click();
      await (await chooserPromise).setFiles(updatedPath);
      await expect(page.getByText("Shared File updated", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");

      const [updatedA, updatedB] = await Promise.all([
        readPageFiles(page, manifest.projectId, pageAId),
        readPageFiles(page, manifest.projectId, pageBId),
      ]);
      expect(updatedA.files[0]?.file.file_id).toBe(sharedFileId);
      expect(updatedB.files[0]?.file.file_id).toBe(sharedFileId);
      expect(updatedA.files[0]?.file.head_version).toBe(2);
      expect(updatedB.files[0]?.file.blob_etag).toBe(updatedA.files[0]?.file.blob_etag);
      expect(updatedA.files[0]?.file.blob_etag).not.toBe(firstVersionEtag);

      await openLibraryFilesPage(page, manifest, LIBRARY_FILES_PAGE_A_KEY, "Shared image A");
      await expect(pageAStage.locator('[data-content-type="image"] img')).toBeVisible();
      await pageAStage.getByRole("button", { name: "History" }).click();
      const history = page.getByRole("dialog", { name: "Page history" });
      await expect(history).toBeVisible();
      await history.getByRole("button", { name: /Shared image v1/u }).click();
      await expect(history.locator('[data-content-type="image"] img')).toBeVisible();
      await history.getByRole("button", { name: "Restore title & body" }).click();
      await history.getByRole("button", { name: "Confirm restore" }).click();
      await expect(history.getByRole("button", { name: "Current Page content" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await history.getByRole("button", { name: "Close Page history" }).click();

      const [restoredA, unchangedB] = await Promise.all([
        readPageFiles(page, manifest.projectId, pageAId),
        readPageFiles(page, manifest.projectId, pageBId),
      ]);
      const restoredBody = restoredA.files.find(
        (item) => item.body_count === 1 && item.file.file_id !== sharedFileId,
      );
      const retainedEntry = restoredA.files.find((item) => item.file.file_id === sharedFileId);
      expect(restoredA.total).toBe(2);
      expect(restoredBody).toMatchObject({
        logical_path: null,
        file: { head_version: 1, blob_etag: firstVersionEtag },
      });
      expect(retainedEntry).toMatchObject({
        logical_path: "assets/shared.png",
        body_count: 0,
        file: { head_version: 2 },
      });
      expect(unchangedB.files[0]).toMatchObject({
        logical_path: "references/shared.png",
        body_count: 1,
        file: { file_id: sharedFileId, head_version: 2 },
      });
      expect(await readFile(updatedPath)).toEqual(Buffer.from(UPDATED_PNG_BASE64, "base64"));
    },
  );
});
