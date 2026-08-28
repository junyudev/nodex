import { expect, test, type Locator, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import type { ScenarioManifest } from "../../scripts/scenarios/contracts";
import {
  PAGE_RELATED_CHAT_ACTIVITY_ATTACHED_SESSION_KEY,
  PAGE_RELATED_CHAT_ACTIVITY_OPEN_ACTION_PAGE_KEY,
  PAGE_RELATED_CHAT_ACTIVITY_PAGE_KEY,
  PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_ID,
  PAGE_RELATED_CHAT_ACTIVITY_THREADLESS_SESSION_KEY,
} from "../../scripts/scenarios/scenarios/page-related-chat-activity";

const requireIdentity = (
  manifest: ScenarioManifest,
  collection: "page" | "entity",
  key: string,
): string => {
  const value = collection === "page" ? manifest.pageIdsByKey[key] : manifest.entityIdsByKey?.[key];
  if (value) return value;
  throw new Error(`page/related-chat-activity manifest has no ${collection} identity ${key}`);
};

const focusProjectHome = async (page: Page, manifest: ScenarioManifest): Promise<void> => {
  const activityPageId = requireIdentity(manifest, "page", PAGE_RELATED_CHAT_ACTIVITY_PAGE_KEY);
  const activityRow = page.locator(`[data-database-view-page-id="${activityPageId}"]:visible`);
  if (await activityRow.isVisible().catch(() => false)) return;
  await page
    .getByRole("button", { name: "Open Related Chat Activity", exact: true })
    .evaluate((element) => (element as HTMLElement).click());
  await page.getByRole("tab", { name: "Project Home" }).waitFor();
  await activityRow.waitFor();
};

const visibleActivityControl = (page: Page, pageId: string) =>
  page.locator(
    `[data-database-view-page-id="${pageId}"]:visible [data-page-chat-activity-control="true"]`,
  );

const waitForStableActivityControl = async (control: Locator): Promise<void> => {
  await expect(async () => {
    const element = await control.elementHandle();
    if (!element) throw new Error("Related Chat activity control is unavailable");
    await control.page().evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(await element.evaluate((node) => node.isConnected)).toBe(true);
  }).toPass({ timeout: 5_000 });
};

test("persists Page-related Chats and projects their activity across Board, List, and Page Stage", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withElectronScenario(
    {
      label: "page-related-chat-activity",
      scenarioId: PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("page-related-chat-activity-runtime-logs", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
        if (screenshot) {
          await testInfo.attach("page-related-chat-activity-failure", {
            body: screenshot,
            contentType: "image/png",
          });
        }
      },
    },
    async ({ application, facts, harness, manifest, page, seed }) => {
      if (!manifest || !facts) throw new Error("Page related Chat scenario did not materialize");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });
      const activityPageId = requireIdentity(manifest, "page", PAGE_RELATED_CHAT_ACTIVITY_PAGE_KEY);
      const openActionPageId = requireIdentity(
        manifest,
        "page",
        PAGE_RELATED_CHAT_ACTIVITY_OPEN_ACTION_PAGE_KEY,
      );
      const attachedSessionId = requireIdentity(
        manifest,
        "entity",
        PAGE_RELATED_CHAT_ACTIVITY_ATTACHED_SESSION_KEY,
      );
      const threadlessSessionId = requireIdentity(
        manifest,
        "entity",
        PAGE_RELATED_CHAT_ACTIVITY_THREADLESS_SESSION_KEY,
      );

      await focusProjectHome(page, manifest);
      const boardControl = visibleActivityControl(page, activityPageId);
      await expect(boardControl).toHaveAttribute(
        "aria-label",
        "2 linked chats, 1 working chat, 1 unread chat",
      );
      await expect(boardControl.locator('[data-page-chat-unread="true"]')).toBeVisible();

      await page
        .getByRole("tablist", { name: "Database views" })
        .getByRole("tab", { name: "List", exact: true })
        .click();
      const listControl = visibleActivityControl(page, activityPageId);
      await expect(listControl).toHaveAttribute(
        "aria-label",
        "2 linked chats, 1 working chat, 1 unread chat",
      );
      await waitForStableActivityControl(listControl);
      await listControl.click();
      await expect(page.getByText("Linked chats", { exact: true })).toBeVisible();
      await expect(
        page.locator(`[data-related-chat-session-id="${attachedSessionId}"]`),
      ).toContainText("Implement activity projection");
      await expect(
        page.locator(`[data-related-chat-session-id="${threadlessSessionId}"]`),
      ).toContainText("No thread yet");
      await page
        .locator(`[data-related-chat-session-id="${attachedSessionId}"] button`)
        .first()
        .click();
      await expect(
        page.locator(`[data-workbench-scene-owner="session:${attachedSessionId}"]:visible`),
      ).toBeVisible();

      await focusProjectHome(page, manifest);
      const returnedControl = visibleActivityControl(page, activityPageId);
      await waitForStableActivityControl(returnedControl);
      await returnedControl.click();
      await page
        .locator(`[data-related-chat-session-id="${threadlessSessionId}"] button`)
        .first()
        .click();
      await expect(
        page.locator(`[data-workbench-scene-owner="session:${threadlessSessionId}"]:visible`),
      ).toBeVisible();

      await focusProjectHome(page, manifest);
      await page
        .getByRole("tablist", { name: "Database views" })
        .getByRole("tab", { name: "Board", exact: true })
        .click();
      await page.locator(`[data-board-uuid-v7="${activityPageId}"]:visible`).waitFor();
      await page.getByRole("button", { name: "Open Page Trace related Chat activity" }).click();
      const pageStage = page.locator(
        `[data-page-stage-page-id="${activityPageId}"][data-page-stage-surface="true"]:visible`,
      );
      await expect(pageStage.getByText("Linked chats", { exact: true })).toBeVisible();
      const relatedChatRows = pageStage.locator("[data-page-stage-related-chat-session-id]");
      await expect(relatedChatRows).toHaveCount(2);
      await pageStage
        .locator('[data-page-stage-related-chat-chip="true"]')
        .filter({ hasText: "Review relationship model" })
        .hover();
      await pageStage
        .getByRole("button", { name: "Remove relation to Review relationship model" })
        .click();
      await expect(relatedChatRows).toHaveCount(1);
      await expect
        .poll(
          async () => (await seed.readPageChats(manifest.projectId, activityPageId)).items.length,
        )
        .toBe(1);
      await expect(visibleActivityControl(page, activityPageId)).toHaveAttribute(
        "aria-label",
        /1 linked chat/u,
      );

      const actionCard = page.locator(`[data-board-uuid-v7="${openActionPageId}"]:visible`);
      await actionCard
        .locator('button[data-card-context-menu-trigger="true"]')
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "Open in", exact: true }).hover();
      await page.getByRole("menuitem", { name: "Open in new chat" }).click();
      await expect
        .poll(
          async () => (await seed.readPageChats(manifest.projectId, openActionPageId)).items.length,
        )
        .toBe(1);

      const restartedPage = await harness.restart();
      await focusProjectHome(restartedPage, manifest);
      await expect(visibleActivityControl(restartedPage, openActionPageId)).toHaveAttribute(
        "aria-label",
        "1 linked chat",
      );
    },
  );
});
