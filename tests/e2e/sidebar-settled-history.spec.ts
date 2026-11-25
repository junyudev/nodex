import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  requireSidebarSettledHistoryFacts,
  SIDEBAR_SETTLED_HISTORY_CHATS as settledChats,
  SIDEBAR_SETTLED_HISTORY_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/sidebar-settled-history";

const HEADING = "data-app-action-sidebar-section-heading";
const THREAD_ROW = "[data-app-action-sidebar-thread-row]";
const THREAD_TITLE = "data-app-action-sidebar-thread-title";
const SETTLED_TOTAL = settledChats.length;

const section = (page: Page, heading: string) => page.locator(`[${HEADING}="${heading}"]:visible`);

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function shelfTitles(shelf: Locator): Promise<string[]> {
  return await shelf
    .locator(`${THREAD_ROW}:visible`)
    .evaluateAll((nodes, attr) => nodes.map((node) => node.getAttribute(attr) ?? ""), THREAD_TITLE);
}

test("browses every settled chat from the shelf to the end of the Settled page", async ({}, testInfo) => {
  await withElectronScenario(
    {
      label: "sidebar-settled-history",
      scenarioId: SIDEBAR_SETTLED_HISTORY_SCENARIO_ID,
      seedThrough: "core",
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("sidebar-settled-history-runtime-logs", {
          body: await readRuntimeLogs(),
          contentType: "text/plain",
        });
        const image = await page?.screenshot().catch(() => null);
        if (image)
          await testInfo.attach("sidebar-settled-history-failure", {
            body: image,
            contentType: "image/png",
          });
      },
    },
    async ({ application, facts, page }) => {
      requireSidebarSettledHistoryFacts(facts);
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 1000 });
      });
      const settled = section(page, "Settled");
      const pager = settled.locator('[role="listitem"]').filter({ hasText: /Show|View all/ });

      await test.step("count every settled chat and reveal the shelf up to its limit", async () => {
        const toggle = settled.locator("[data-app-action-sidebar-section-toggle]");
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        // The pager counts every settled chat before the shelf has read them all.
        await expect(
          pager.getByRole("button", { name: `View all ${SETTLED_TOTAL}`, exact: true }),
        ).toBeVisible();
        await expect
          .poll(() => shelfTitles(settled))
          .toEqual(settledChats.slice(0, 10).map((chat) => chat.title));
        for (let step = 0; step < 4; step += 1) {
          await pager.getByRole("button", { name: "Show more", exact: true }).click();
        }
        await expect
          .poll(() => shelfTitles(settled))
          .toEqual(settledChats.slice(0, 30).map((chat) => chat.title));
        await expect(pager.getByRole("button", { name: "Show more", exact: true })).toHaveCount(0);
        await capture(page, testInfo, "settled-shelf-view-all");
      });

      const list = page.locator("[data-settled-chats-list]");
      const rows = list.locator("[data-settled-chat-row]");
      const note = list.locator("[data-settled-chats-note]");

      await test.step("open the Settled page and scroll back to its first settled chat", async () => {
        await pager.getByRole("button", { name: `View all ${SETTLED_TOTAL}`, exact: true }).click();
        await expect(page.locator("[data-settled-chats-total]")).toHaveText(String(SETTLED_TOTAL));
        await capture(page, testInfo, "settled-page-top");
        // Core reads chats in windows of fifty; reaching the end needs the second window too.
        await expect
          .poll(async () => {
            await rows.last().scrollIntoViewIfNeeded();
            return await rows.count();
          })
          .toBe(SETTLED_TOTAL);
        await expect(note).toHaveText(`That’s all ${SETTLED_TOTAL} settled chats`);
        await expect(rows.last()).toContainText(settledChats.at(-1)!.title);
        await capture(page, testInfo, "settled-page-end");
      });

      await test.step("search and filter the page", async () => {
        await page.getByLabel("Search settled chats").fill("audit");
        const audits = settledChats.filter((chat) => chat.title.startsWith("Audit"));
        await expect(page.locator("[data-settled-chats-total]")).toHaveText(String(audits.length));
        await expect(rows).toHaveCount(audits.length);
        await expect(note).toHaveText(`That’s all ${audits.length} matches`);
        await capture(page, testInfo, "settled-page-search");

        await page.getByLabel("Search settled chats").fill("");
        await page.getByRole("button", { name: "Show chats from" }).click();
        await page.getByRole("menuitem", { name: "Core", exact: true }).click();
        const core = settledChats.filter((chat) => chat.project === "core");
        await expect(page.locator("[data-settled-chats-total]")).toHaveText(String(core.length));
        await expect(rows).toHaveCount(core.length);
      });

      await test.step("reopen a chat from its row", async () => {
        const first = rows.first();
        const sessionId = await first.getAttribute("data-settled-chat-row");
        await first.hover();
        await first.getByRole("button", { name: "Reopen chat" }).click();
        await expect(list.locator(`[data-settled-chat-row="${sessionId}"]`)).toHaveCount(0);
      });
    },
  );
});
