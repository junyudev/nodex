import type { IpcApi } from "../../src/shared/ipc-api";
import * as Y from "yjs";
import { openPageDocument } from "../../src/shared/block-documents";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../scripts/scenarios/scenarios/document-sync-recovery";
import { openBoardPageFromCard } from "./support/open-board-page";
import { dragBlockFromEditorWithMouse } from "./support/drag-block-with-mouse";
import { selectEditorBlockRange } from "./support/select-editor-block-range";

test("editing, native reorder and cancelled structural waits recover through Electron and Core", async () => {
  test.setTimeout(180_000);
  test.skip(
    process.platform === "win32",
    "This fault injection pauses only a disposable Unix Core process",
  );
  await withElectronScenario(
    {
      label: "document-sync-recovery",
      scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        if (page)
          await test.info().attach("recovery-ui", {
            body: await page.locator("body").innerText(),
            contentType: "text/plain",
          });
        if (page)
          await test.info().attach("recovery-focus", {
            body: JSON.stringify(
              await page.evaluate(() => ({
                active: document.activeElement?.outerHTML,
                selection: window.getSelection()?.toString(),
              })),
            ),
            contentType: "application/json",
          });
        await test
          .info()
          .attach("recovery-runtime", { body: await readRuntimeLogs(), contentType: "text/plain" });
      },
    },
    async ({ application, page, profile, manifest, seed }) => {
      if (!manifest) throw new Error("Recovery scenario was not materialized");
      const sourceId = manifest.pageIdsByKey.source!;
      const childId = manifest.pageIdsByKey.child!;
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 }),
      );
      await page.getByRole("button", { name: "Open Document Recovery", exact: true }).click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      await openBoardPageFromCard({
        card: page.locator(`[data-board-uuid-v7="${sourceId}"]`),
        page,
        tabName: "Edit and recover",
      });
      const editor = page.locator(`[data-page-stage-page-id="${sourceId}"]:visible .nfm-editor`);
      const surface = editor.locator('.ProseMirror[contenteditable="true"]').first();
      const first = surface
        .locator(".bn-block[data-id]")
        .filter({ hasText: /^First paragraph$/ })
        .first();
      const last = surface
        .locator(".bn-block[data-id]")
        .filter({ hasText: /^Last paragraph$/ })
        .first();
      const owner = surface.locator(`.bn-block[data-id="${childId}"]`);
      await expect(owner).toBeVisible({ timeout: 15_000 });
      const firstId = await first.getAttribute("data-id");
      const lastId = await last.getAttribute("data-id");
      if (!firstId || !lastId) throw new Error("Paragraphs have no stable identity");
      const firstBlock = surface.locator(`.bn-block[data-id="${firstId}"]`);
      const lastBlock = surface.locator(`.bn-block[data-id="${lastId}"]`);
      await firstBlock.locator(".bn-inline-content").click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
      await page.keyboard.type(" saved");
      await expect
        .poll(async () => (await seed.readPage(manifest.projectId, sourceId)).descriptionPreview)
        .toContain("First paragraph saved");
      await dragBlockFromEditorWithMouse({
        page,
        sourceBlock: firstBlock,
        sourceEditor: editor,
        target: lastBlock,
        targetYRatio: 0.85,
        expectedFeedback: editor.locator("[data-block-transfer-drop-indicator]"),
      });
      const isAfter = async () =>
        (await firstBlock.boundingBox())!.y > (await lastBlock.boundingBox())!.y;
      await expect.poll(isAfter).toBe(true);
      await firstBlock.locator(".bn-inline-content").click();
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Z`);
      await expect.poll(isAfter).toBe(false);

      // Select across the owning Page using the same native selection helper as the editor smoke.
      await selectEditorBlockRange({ page, editor: surface, firstBlock, lastBlock: lastBlock });
      await page.keyboard.press("Backspace");
      await expect(owner).toHaveCount(0);
      await expect
        .poll(
          async () => await surface.evaluate((element) => element.contains(document.activeElement)),
        )
        .toBe(true);
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Z`);
      await expect(owner).toBeVisible();
      await expect.poll(isAfter).toBe(false);

      // The owner can reappear optimistically before its structural Undo commits.
      // Pause Core only after that earlier operation has restored readable canonical ownership.
      await expect
        .poll(async () => {
          try {
            return (await seed.readPage(manifest.projectId, childId)).title;
          } catch {
            return null;
          }
        })
        .toBe("Owned child");

      const descriptor: unknown = JSON.parse(
        await readFile(path.join(profile.nodexHome, "run/core/core.json"), "utf8"),
      );
      if (
        !descriptor ||
        typeof descriptor !== "object" ||
        !("pid" in descriptor) ||
        typeof descriptor.pid !== "number" ||
        descriptor.pid <= 0
      )
        throw new Error("Disposable Core descriptor is invalid");
      const pid = descriptor.pid;
      process.kill(pid, "SIGSTOP");
      try {
        await firstBlock.locator(".bn-inline-content").click();
        await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
        await page.keyboard.type(" pending");
        await dragBlockFromEditorWithMouse({
          page,
          sourceBlock: firstBlock,
          sourceEditor: editor,
          target: lastBlock,
          targetYRatio: 0.85,
          expectedFeedback: editor.locator("[data-block-transfer-drop-indicator]"),
        });
        const cancel = page.getByRole("button", { name: "Cancel", exact: true });
        await expect(cancel).toBeVisible({ timeout: 5000 });
        await cancel.click();
        await expect(cancel).toHaveCount(0);
      } finally {
        process.kill(pid, "SIGCONT");
      }
      await expect
        .poll(async () => (await seed.readPage(manifest.projectId, sourceId)).descriptionPreview)
        .toContain("pending");
      expect(await isAfter()).toBe(false);
      const beforeReload = (await seed.readPage(manifest.projectId, sourceId)).descriptionPreview;
      await page.reload();
      await expect(
        page.locator(`[data-page-stage-page-id="${sourceId}"]:visible .nfm-editor`),
      ).toBeVisible({ timeout: 15000 });
      expect((await seed.readPage(manifest.projectId, sourceId)).descriptionPreview).toBe(
        beforeReload,
      );
      expect(
        (await seed.readPage(manifest.projectId, manifest.pageIdsByKey.other!)).descriptionPreview,
      ).toContain("remains independent");

      // Fault fixture: preserve a real engine snapshot containing edits Core has never seen.
      const retainedBytes = await page.evaluate(async (documentId) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("nodex-document-cache");
          request.onsuccess = () => resolve(request.result);
          request.addEventListener("error", () => reject(request.error), { once: true });
        });
        try {
          return await new Promise<number[]>((resolve, reject) => {
            const request = database
              .transaction("document-checkpoints", "readonly")
              .objectStore("document-checkpoints")
              .getAll();
            request.addEventListener("error", () => reject(request.error), { once: true });
            request.onsuccess = () => {
              const row = request.result.find(
                (value: { documentId: string }) => value.documentId === documentId,
              );
              if (!row) {
                reject(new Error("Checkpoint not found"));
                return;
              }
              resolve(Array.from(new Uint8Array(row.state)));
            };
          });
        } finally {
          database.close();
        }
      }, manifest.entityIdsByKey!.sourceDocument!);
      // Checkpoints contain local deltas, so hydrate their canonical dependencies
      // before authoring an independent offline edit in this fault fixture.
      const canonicalBytes = await page.evaluate(
        async ({ projectId, documentId }) => {
          const api = window.api;
          if (!api) throw new Error("Development renderer bridge is unavailable");
          const request = { projectId, documentId, clientSessionId: "recovery-fixture" };
          const subscribed = (await api.invoke(
            "document-sync:subscribe",
            request,
          )) as IpcApi["document-sync:subscribe"]["result"];
          if (!subscribed.ok) throw new Error(subscribed.error.message);
          try {
            const synced = (await api.invoke("document-sync:sync", {
              ...request,
              stateVector: new Uint8Array([0]),
            })) as IpcApi["document-sync:sync"]["result"];
            if (!synced.ok) throw new Error(synced.error.message);
            return Array.from(synced.value.update);
          } finally {
            await api.invoke("document-sync:unsubscribe", request);
          }
        },
        { projectId: manifest.projectId, documentId: manifest.entityIdsByKey!.sourceDocument! },
      );
      const retainedDocument = new Y.Doc();
      Y.applyUpdate(retainedDocument, new Uint8Array(canonicalBytes));
      Y.applyUpdate(retainedDocument, new Uint8Array(retainedBytes));
      const { title } = openPageDocument(retainedDocument);
      expect(title.toString()).toBe("Edit and recover");
      title.insert(title.length, " · recovered draft");
      expect(title.toString()).toBe("Edit and recover · recovered draft");
      const retainedState = Array.from(Y.encodeStateAsUpdate(retainedDocument));
      retainedDocument.destroy();
      await page.evaluate(
        async ({ documentId, retainedState }) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("nodex-document-cache");
            request.onsuccess = () => resolve(request.result);
            request.addEventListener("error", () => reject(request.error), { once: true });
          });
          try {
            await new Promise<void>((resolve, reject) => {
              const transaction = database.transaction("document-checkpoints", "readwrite");
              const store = transaction.objectStore("document-checkpoints");
              const request = store.getAll();
              request.onsuccess = () => {
                const row = request.result.find(
                  (value: { documentId: string }) => value.documentId === documentId,
                );
                if (!row) {
                  transaction.abort();
                  return;
                }
                store.put({
                  ...row,
                  state: new Uint8Array(retainedState),
                  submissions: [
                    {
                      documentId,
                      storeEpoch: row.storeEpoch,
                      generation: row.generation,
                      baseHeadSeq: row.headSeq,
                      clientSessionId: "previous-window",
                      updateId: "uncertain-save",
                      update: new Uint8Array(retainedState),
                      touchedBlockIds: [],
                    },
                  ],
                });
              };
              transaction.oncomplete = () => resolve();
              const rejectTransaction = () =>
                reject(transaction.error ?? new Error("Recovery checkpoint is unavailable"));
              transaction.addEventListener("abort", rejectTransaction, { once: true });
              transaction.addEventListener("error", rejectTransaction, { once: true });
            });
          } finally {
            database.close();
          }
        },
        { documentId: manifest.entityIdsByKey!.sourceDocument!, retainedState },
      );
      await page.reload();
      const review = page.getByRole("button", { name: "Review", exact: true });
      await expect(review).toBeVisible({ timeout: 15000 });
      // A background window must converge through Core delivery without a focus refresh.
      const audienceOpened = application.waitForEvent("window");
      expect(await page.evaluate(() => window.api?.invoke("window:new", {}))).toBe(true);
      const audience = await audienceOpened;
      await audience.evaluate(() => window.api?.awaitInitialization?.());
      await audience.getByRole("button", { name: "Open Document Recovery", exact: true }).click();
      await audience.getByRole("tab", { name: "Project Home" }).waitFor();
      await openBoardPageFromCard({
        card: audience.locator(`[data-board-uuid-v7="${sourceId}"]`),
        page: audience,
        tabName: "Edit and recover",
      });
      const audienceReview = audience.getByRole("button", { name: "Review", exact: true });
      await expect(audienceReview).toBeVisible();
      await page.bringToFront();
      await review.click();
      const dialog = page.getByRole("dialog", { name: "Unsaved edits" });
      await expect(
        dialog.getByRole("button", { name: "Restore edits", exact: true }),
      ).toBeVisible();
      await expect(dialog.getByRole("button", { name: "After restoring" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await dialog.screenshot({ path: test.info().outputPath("retained-edits-review.png") });
      await test.info().attach("retained-edits-review", {
        path: test.info().outputPath("retained-edits-review.png"),
        contentType: "image/png",
      });
      const exportRecovery = dialog.getByRole("button", { name: "Export", exact: true });
      const exportPath = test.info().outputPath("document-recovery.json");
      await application.evaluate(({ BrowserWindow }, destination) => {
        BrowserWindow.getAllWindows()[0]!.webContents.session.once(
          "will-download",
          (_event, download) => {
            download.setSavePath(destination);
          },
        );
      }, exportPath);
      await exportRecovery.click();
      await expect
        .poll(async () => {
          try {
            return JSON.parse(await readFile(exportPath, "utf8"));
          } catch {
            return null;
          }
        })
        .toMatchObject({
          format: "nodex-document-recovery",
          version: 2,
          inspection: expect.objectContaining({
            capture: expect.objectContaining({
              source: expect.objectContaining({
                submissions: [
                  expect.objectContaining({
                    clientSessionId: "previous-window",
                    updateId: "uncertain-save",
                  }),
                ],
              }),
            }),
          }),
        });
      expect((await seed.readPage(manifest.projectId, sourceId)).descriptionPreview).toBe(
        beforeReload,
      );
      // Export is only a backup; discard and its undo are persisted choices.
      await dialog.getByRole("button", { name: "Discard draft", exact: true }).click();
      await dialog.getByRole("button", { name: "Discard", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Undo discard", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Undo discard", exact: true }).click();
      await dialog.getByRole("button", { name: "Restore edits", exact: true }).click();
      await expect
        .poll(async () => (await seed.readPage(manifest.projectId, sourceId)).title)
        .toBe("Edit and recover · recovered draft");
      await expect(dialog.getByRole("status")).toHaveText("Edits restored and saved.");
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect(review).toHaveCount(0);
      await expect(audienceReview).toHaveCount(0);
      await page.reload();
      await expect(
        page.locator(`[data-page-stage-page-id="${sourceId}"]:visible .nfm-editor`),
      ).toBeVisible();
      await expect(review).toHaveCount(0);
      expect((await seed.readPage(manifest.projectId, sourceId)).title).toBe(
        "Edit and recover · recovered draft",
      );
    },
  );
});
