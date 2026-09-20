import { expect, test } from "@playwright/test";
import { recoverySummary } from "../../src/renderer/lib/document-recovery-staging";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../scripts/scenarios/scenarios/document-sync-recovery";
import { openBoardPageFromCard } from "./support/open-board-page";

test("unverified retained edits can be removed without changing the source Page", async () => {
  test.setTimeout(120_000);
  await withElectronScenario(
    { label: "local-recovery-removal", scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID },
    async ({ application, page, manifest, seed }) => {
      if (!manifest) throw new Error("Recovery scenario was not materialized");
      const pageId = manifest.pageIdsByKey.source!;
      const original = await seed.readPage(manifest.projectId, pageId);
      await page.getByRole("button", { name: "Open Document Recovery", exact: true }).click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      await openBoardPageFromCard({
        card: page.locator(`[data-board-uuid-v7="${pageId}"]`),
        page,
        tabName: "Edit and recover",
      });
      // Historical unbound storage is the subject of this fixture; canonical content comes from the scenario.
      const row = {
        recoveryId: "draft:unverified",
        documentId: manifest.entityIdsByKey!.sourceDocument!,
        storeEpoch: "epoch:unverified",
        generation: 1,
        headSeq: 1,
        state: new Uint8Array([0, 0]),
        updatedAt: "2026-09-04T00:00:00.000Z",
      };
      const summary = recoverySummary("yjs", row.recoveryId, row);
      await page.evaluate(
        async ({ row, summary }) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("nodex-document-cache");
            request.addEventListener("success", () => resolve(request.result), { once: true });
            request.addEventListener("error", () => reject(request.error), { once: true });
          });
          try {
            await new Promise<void>((resolve, reject) => {
              const transaction = database.transaction(
                ["document-recovery", "recovery-staging-directory"],
                "readwrite",
              );
              transaction
                .objectStore("document-recovery")
                .put({ ...row, state: new Uint8Array(row.state) });
              transaction.objectStore("recovery-staging-directory").put(summary);
              transaction.addEventListener("complete", () => resolve(), { once: true });
              transaction.addEventListener("abort", () => reject(transaction.error), {
                once: true,
              });
            });
          } finally {
            database.close();
          }
        },
        {
          row: { ...row, state: Array.from(row.state) },
          summary: { ...summary, rawKey: row.recoveryId },
        },
      );
      await page.reload();
      const opened = application.waitForEvent("window");
      await page.evaluate(() => window.api?.invoke("window:new", {}));
      const audience = await opened;
      await audience.getByRole("button", { name: "Open Document Recovery", exact: true }).click();
      await expect(
        audience.getByRole("button", { name: "Content issues", exact: true }),
      ).toBeVisible();
      await page.bringToFront();
      await page.getByRole("button", { name: "Content issues", exact: true }).click();
      await page.getByRole("button", { name: "Review edits", exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: "Unsaved edits" });
      await expect(
        dialog.getByText(/source Library or access context cannot be verified/),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Remove local draft", exact: true }).click();
      await expect(dialog.getByText(/This cannot be undone/)).toBeVisible();
      await dialog.screenshot({ path: test.info().outputPath("remove-local-draft.png") });
      await dialog.getByRole("button", { name: "Keep", exact: true }).click();
      await dialog.getByRole("button", { name: "Remove local draft", exact: true }).click();
      await dialog.getByRole("button", { name: "Remove permanently", exact: true }).click();
      await expect(dialog.getByText("No unsaved drafts need attention.")).toBeVisible();
      await dialog.getByRole("button", { name: "Later", exact: true }).click();
      await expect(page.getByRole("button", { name: "Content issues", exact: true })).toHaveCount(
        0,
      );
      await page.reload();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      await expect(page.getByRole("button", { name: "Content issues", exact: true })).toHaveCount(
        0,
      );
      await expect(
        audience.getByRole("button", { name: "Content issues", exact: true }),
      ).toHaveCount(0);
      const current = await seed.readPage(manifest.projectId, pageId);
      expect(current.title).toBe(original.title);
      expect(current.descriptionPreview).toBe(original.descriptionPreview);
    },
  );
});
