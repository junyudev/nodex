import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { invokeIpc } from "./support/editor-scenario";

test("a chat the Inbox starts opens with its message's Page beside it unless turned off", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const artifacts =
    process.env.NODEX_INBOX_NEW_CHAT_PAGE_ARTIFACT_DIR ??
    testInfo.outputPath("inbox-new-chat-page-review");
  await mkdir(artifacts, { recursive: true });
  const claims: { name: string; expected: unknown; actual: unknown }[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  await withElectronScenario(
    { label: "inbox-new-chat-page", scenarioId: null },
    async ({ page, seed }) => {
      await invokeIpc(page, "settings:inbox:update", { suggestions: "off" });
      const shownText = "Sketch a calmer empty state for Boards.";
      const hiddenText = "List the sync settings worth keeping.";
      const shown = await seed.sendInboxMessage(shownText);
      const hidden = await seed.sendInboxMessage(hiddenText);
      await page.setViewportSize({ width: 1440, height: 860 });

      const inbox = page.locator('[data-inbox-scope="library"]');
      const openInbox = async () => {
        await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
        await expect(inbox).toBeVisible();
      };
      // Each tab group of the selected Scene's right stack has its own tab row in the title row.
      const rightTabs = () =>
        page.locator('[data-panel-tab-row^="right:"]').filter({ visible: true }).getByRole("tab");
      const startChat = async (pageId: string) => {
        const row = page.locator(`[data-inbox-page-id="${pageId}"]`);
        await row.getByTestId("inbox-message-unit").hover();
        await row.getByRole("button", { name: "Handle manually", exact: true }).click();
        await row.getByRole("button", { name: "Start chat", exact: true }).click();
        // Core has accepted the decision once the message links to its chat.
        await expect(row.getByRole("button", { name: "Open chat", exact: true })).toBeVisible();
      };
      const openChatFromHistory = async (pageId: string, title: string) => {
        await inbox.getByRole("tab", { name: /^History/ }).click();
        const row = page.locator(
          `[data-testid="inbox-history-row"][data-inbox-page-id="${pageId}"]`,
        );
        await row.locator("button[aria-expanded]").click();
        await row.getByRole("button", { name: "Open chat", exact: true }).click();
        // The chat, titled after its message, is the one now shown.
        await expect(
          page
            .locator('[data-app-action-sidebar-thread-row][aria-current="page"]')
            .filter({ hasText: title }),
        ).toHaveCount(1);
        await expect(inbox).toBeHidden();
      };
      const chatPanelTabs = async () =>
        (await rightTabs().locator("[data-app-shell-tab-title]").allInnerTexts()).map((title) =>
          title.trim(),
        );

      let status: "passed" | "failed" = "failed";
      let failure: string | null = null;
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1440, height: 860 },
      });
      try {
        await openInbox();
        await startChat(shown.pageId);
        // Starting the chat keeps the Inbox in view.
        claim("Starting a chat stays in the Inbox", true, await inbox.isVisible());

        await openChatFromHistory(shown.pageId, shownText);
        await expect(rightTabs().filter({ hasText: shownText })).toHaveCount(1);
        await expect(
          page.getByTestId("session-right-panel").getByText(shownText).first(),
        ).toBeVisible();
        claim(
          "The new chat opens with its message's Page in the right panel",
          [shownText],
          await chatPanelTabs(),
        );
        await page.screenshot({ path: path.join(artifacts, "1-chat-with-page.png") });

        await invokeIpc(page, "settings:inbox:update", { showPageBesideNewChats: false });
        await page.reload();
        await openInbox();
        await inbox.getByRole("tab", { name: /^Inbox/ }).click();
        await startChat(hidden.pageId);
        await openChatFromHistory(hidden.pageId, hiddenText);
        await expect(rightTabs().filter({ hasText: hiddenText })).toHaveCount(0);
        claim(
          "With the preference off, the new chat opens without the Page",
          [],
          await chatPanelTabs(),
        );
        await page.screenshot({ path: path.join(artifacts, "2-chat-without-page.png") });
        status = "passed";
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        await page.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => undefined);
        throw error;
      } finally {
        await page.screencast.stop();
        await writeFile(
          path.join(artifacts, "result.json"),
          `${JSON.stringify({ status, fixture: "fresh disposable Electron Profile; suggestions disabled; two synthetic Library Inbox messages; scenario Codex app server", claims, failure }, null, 2)}\n`,
        );
      }
    },
  );
});
