import { expect, test, type Page } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { landingSharedPagesScenario } from "../../scripts/scenarios/scenarios/landing-showcase";

const openProjectChat = async (page: Page, projectId: string, title: string) => {
  const projectRow = page.locator(`[data-app-action-sidebar-project-id="${projectId}"]:visible`);
  await expect(async () => {
    await projectRow.hover();
    const expand = projectRow.getByRole("button", { name: "Expand project", exact: true });
    if (await expand.count()) await expand.click({ timeout: 1_000 });
    await expect(
      page.locator(`[data-app-action-sidebar-project-list-id="${projectId}"]:visible`),
    ).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await page
    .locator(
      `[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-title="${title}"]:visible`,
    )
    .click();
};

/** `C` is an app shortcut: it waits until no field or editor holds the keyboard. */
const pressCapture = async (page: Page) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("c");
};

test("C captures a message to the Project's Inbox from one of its chats without leaving it", async ({}, testInfo) => {
  test.setTimeout(150_000);
  await withElectronScenario(
    {
      label: "inbox-capture",
      scenarioId: landingSharedPagesScenario.id,
      seedThrough: "core",
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("inbox-capture-runtime-logs", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
        if (!screenshot) return;
        await testInfo.attach("inbox-capture-failure", {
          body: screenshot,
          contentType: "image/png",
        });
      },
    },
    async ({ application, page, manifest }) => {
      const chatId = manifest?.entityIdsByKey?.chat;
      if (!manifest || !chatId) throw new Error("landing/shared-pages did not materialize");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });
      await openProjectChat(page, manifest.projectId, "Update implementation notes");
      const chatScene = page.locator(`[data-workbench-scene-owner="session:${chatId}"]:visible`);
      await expect(chatScene).toBeVisible();
      const capture = page.getByRole("dialog", { name: "Capture to Tinyboard Inbox" });
      const message = capture.getByRole("textbox", { name: "Message your Inbox" });

      await test.step("writes the message first and lets Nodex name it", async () => {
        await pressCapture(page);
        await expect(message).toBeFocused();
        await expect(capture.getByRole("textbox", { name: "Message title" })).toHaveCount(0);
        await page.keyboard.type("Check the release checklist before Friday");
        await page.keyboard.press("Enter");
        await expect(capture).toHaveCount(0);
        await expect(page.getByText("Sent to Tinyboard Inbox", { exact: true })).toBeVisible();
        // The capture never takes the user away from the chat.
        await expect(chatScene).toBeVisible();
      });

      await test.step("gives the next message a title of the sender's own", async () => {
        await pressCapture(page);
        await expect(message).toBeFocused();
        await capture.getByRole("button", { name: "Add title" }).click();
        // Typing right away goes to the title, not the message beneath it.
        await page.keyboard.type("Release prep");
        const title = capture.getByRole("textbox", { name: "Message title" });
        await expect(title).toHaveValue("Release prep");
        await expect(message).toHaveValue("");
        await page.keyboard.press("Enter");
        await expect(message).toBeFocused();
        await page.keyboard.type("Draft the notes and tag the build");
        await page.keyboard.press("Enter");
        await expect(capture).toHaveCount(0);
      });

      await test.step("lands both in the Project's Inbox, where C focuses the composer", async () => {
        await page
          .getByRole("alert")
          .filter({ hasText: "Sent to Tinyboard Inbox" })
          .getByRole("button", { name: "Open", exact: true })
          // The first message's toast may still be leaving as the second arrives.
          .last()
          .click();
        const projectScene = page.locator(
          `[data-workbench-scene-owner="project:${manifest.projectId}"]:visible`,
        );
        await expect(projectScene).toBeVisible();
        await expect(
          projectScene.getByText("Check the release checklist before Friday", { exact: true }),
        ).toBeVisible();
        await expect(
          projectScene.getByText("Draft the notes and tag the build", { exact: true }),
        ).toBeVisible();

        await pressCapture(page);
        await expect(capture).toHaveCount(0);
        await expect(
          projectScene.getByRole("textbox", { name: "Message your Inbox" }),
        ).toBeFocused();
      });

      await test.step("keeps the sender's title on the Board", async () => {
        await page.getByRole("button", { name: "Open Board", exact: true }).click();
        await expect(page.getByText("Release prep", { exact: true }).first()).toBeVisible();
      });
    },
  );
});
