import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { DOCUMENT_RECOVERY_REVIEW_SCENARIO_ID } from "../../scripts/scenarios/scenarios/document-recovery-review";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { openProjectBoard } from "../../scripts/scenarios/harness/project-board-ui";
import { openBoardPageFromCard } from "./support/open-board-page";

const reviewDialog = (page: Page) => page.getByRole("dialog", { name: /^Unsaved edits/u });

test("the review answers what each draft adds and leads to one decision", async () => {
  test.setTimeout(180_000);
  await withElectronScenario(
    {
      label: "document-recovery-review",
      scenarioId: DOCUMENT_RECOVERY_REVIEW_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        if (page)
          await test.info().attach("recovery-ui", {
            body: (
              await page.locator('[role="dialog"], [role="status"], [role="alert"]').allInnerTexts()
            ).join("\n---\n"),
            contentType: "text/plain",
          });
        await test
          .info()
          .attach("recovery-runtime", { body: await readRuntimeLogs(), contentType: "text/plain" });
      },
    },
    async ({ application, page, manifest, seed }) => {
      if (!manifest) throw new Error("Recovery review scenario was not materialized");
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 }),
      );
      const { projectId } = manifest;

      const issues = page.getByRole("button", { name: "Content issues", exact: true });
      await expect(issues).toBeVisible({ timeout: 15_000 });
      await issues.click();
      await page.getByRole("button", { name: "Review edits", exact: true }).first().click();
      const dialog = reviewDialog(page);
      await expect(dialog).toBeVisible();
      const shot = async (name: string) => {
        await page.waitForTimeout(250);
        const path = test.info().outputPath(`${name}.png`);
        await dialog.screenshot({ path });
        await test.info().attach(name, { path, contentType: "image/png" });
      };
      const open = async (title: string) =>
        await dialog
          .getByRole("navigation", { name: "Unsaved edits" })
          .getByRole("button", { name: new RegExp(`^${title}`, "u") })
          .click();

      // A merge Core can apply states its effect, with word changes in place.
      await open("手机 App 发布计划");
      await expect(
        dialog.getByText("Restoring adds 1 block, changes 1 and removes 1."),
      ).toBeVisible();
      await expect(dialog.getByRole("region", { name: "Added" })).toContainText("隐私问卷");
      await expect(dialog.getByRole("region", { name: "Removed" })).toContainText("通知放到");
      const edited = dialog.getByRole("region", { name: "Changed" });
      await expect(
        edited.locator('[data-style-type="backgroundColor"][data-value="red"]'),
      ).toHaveText("十一月底");
      await expect(
        edited.locator('[data-style-type="backgroundColor"][data-value="green"]'),
      ).toHaveText("十二月初");
      await shot("restore-light");
      await page.emulateMedia({ colorScheme: "dark" });
      await shot("restore-dark");
      await page.emulateMedia({ colorScheme: "light" });

      // A draft Core refuses to apply still shows what would otherwise be lost, and can carry it over.
      await open("设计评审记录");
      await expect(dialog.getByText(/aren’t in the Page yet/u)).toBeVisible();
      await expect(dialog.getByText(/weren’t captured with them/u)).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Restore edits" })).toHaveCount(0);
      await dialog.getByRole("button", { name: "Copy new content", exact: true }).click();
      await expect
        .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
        .toContain("空状态也要重新设计");
      await expect
        .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
        .not.toContain("对话框不再用");
      await shot("cannot-merge-light");
      await page.emulateMedia({ colorScheme: "dark" });
      await shot("cannot-merge-dark");
      await page.emulateMedia({ colorScheme: "light" });

      // Engine evidence that changes nothing readable is safe to let go of, and says so.
      await open("周报");
      await expect(
        dialog.getByText("Nothing new. Everything in these edits is already in the Page."),
      ).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Restore edits" })).toHaveCount(0);
      await shot("nothing-new-light");

      // Discard needs no confirmation because it can be undone, and review moves on.
      await dialog.getByRole("button", { name: "Discard", exact: true }).click();
      const undo = dialog.getByRole("button", { name: "Undo", exact: true });
      await expect(undo).toBeVisible();
      await expect(dialog.getByRole("navigation").getByRole("button")).toHaveCount(2);
      await shot("discarded-undo-light");
      await undo.click();
      await expect(dialog.getByRole("navigation").getByRole("button")).toHaveCount(3);
      await expect(dialog.getByText("Nothing new.", { exact: false })).toBeVisible();

      // Restoring commits forward and leaves the rest of the queue open.
      await open("手机 App 发布计划");
      await dialog.getByRole("button", { name: "Restore edits", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await seed.readPage(projectId, manifest.pageIdsByKey.plan!)).descriptionPreview,
        )
        .toContain("十二月初");
      await expect(dialog.getByRole("navigation").getByRole("button")).toHaveCount(2);

      // Export and the more menu never resolve anything.
      await dialog.getByRole("button", { name: "More actions", exact: true }).click();
      await expect(
        page.getByRole("menuitem", { name: "Export backup", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog.getByRole("navigation").getByRole("button")).toHaveCount(2);

      // Closing keeps what remains pending; nothing else asks the person to postpone.
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(issues).toBeVisible();

      // From inside a Page the review holds only that Page's draft, so no list appears.
      await page.getByRole("button", { name: "Open Recovery Review", exact: true }).click();
      await openProjectBoard(page);
      await openBoardPageFromCard({
        card: page.locator(`[data-board-uuid-v7="${manifest.pageIdsByKey.notes!}"]`),
        page,
        tabName: "设计评审记录",
      });
      await page.getByRole("button", { name: "Review", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Copy new content" })).toBeVisible();
      await expect(dialog.getByRole("navigation", { name: "Unsaved edits" })).toHaveCount(0);
      await shot("single-draft-light");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    },
  );
});
