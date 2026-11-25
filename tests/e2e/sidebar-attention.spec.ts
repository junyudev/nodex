import { expect, test, type Locator, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  requireSidebarAttentionFacts,
  SIDEBAR_ATTENTION_CHATS as chats,
  SIDEBAR_ATTENTION_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/sidebar-attention";

const HEADING = "data-app-action-sidebar-section-heading";
const THREAD_ROW = "[data-app-action-sidebar-thread-row]";
const THREAD_TITLE = "data-app-action-sidebar-thread-title";
const section = (page: Page, heading: string) => page.locator(`[${HEADING}="${heading}"]:visible`);
const thread = (scope: Locator, chat: { title: string }) =>
  scope.locator(`${THREAD_ROW}[${THREAD_TITLE}="${chat.title}"]:visible`);

async function expandSection(section: Locator) {
  const toggle = section.locator("[data-app-action-sidebar-section-toggle]");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function expectChats(scope: Locator, chats: readonly { title: string }[], verify = expect) {
  const rows = scope.locator(`${THREAD_ROW}:visible`);
  const byTitle = (a: string, b: string) => a.localeCompare(b);
  await verify
    .poll(async () => {
      const titles = await rows.evaluateAll(
        (nodes, attr) => nodes.map((node) => node.getAttribute(attr) ?? ""),
        THREAD_TITLE,
      );
      return titles.sort(byTitle);
    })
    .toEqual(chats.map((chat) => chat.title).sort(byTitle));
}

test("arranges chats by attention and applies sidebar actions to their live lanes", async ({}, testInfo) => {
  await withElectronScenario(
    {
      label: "sidebar-attention",
      scenarioId: SIDEBAR_ATTENTION_SCENARIO_ID,
      seedThrough: "core",
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("sidebar-attention-runtime-logs", {
          body: await readRuntimeLogs(),
          contentType: "text/plain",
        });
        const image = await page?.screenshot().catch(() => null);
        if (image)
          await testInfo.attach("sidebar-attention-failure", {
            body: image,
            contentType: "image/png",
          });
      },
    },
    async ({ application, facts, page }) => {
      const { coreProjectId } = requireSidebarAttentionFacts(facts);
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 1200 });
      });

      const sidebar = page.locator("[data-app-action-sidebar-scroll]:visible");
      const active = section(page, "Active");
      const snoozed = section(page, "Snoozed");
      const settled = section(page, "Settled");
      const inbox = page.getByTestId("sidebar-inbox-row-wrapper");
      const arrangeByAttention = page.getByRole("button", { name: "Arrange by attention" });
      const review = thread(active, chats.review);
      // A chat filed in a Section takes the lane its state puts it in.
      const quietChats = [chats.quietNodex, chats.quietCore, chats.quietWeb, chats.releaseNodex];
      const settleRead = active.locator("[data-app-action-sidebar-settle-read]");
      const initialSettled = [chats.settledCore, chats.settledWeb, chats.settledProjectless];
      const waitingGlyph = inbox.getByLabel("Something in the Inbox waits for your answer");

      await test.step("show the seeded lanes, Page wording, and Library Inbox", async () => {
        // Chats sit under their Projects until the toggle beside Search arranges them by attention.
        await expect(arrangeByAttention).toHaveAttribute("aria-pressed", "false");
        await arrangeByAttention.click();
        await expect(arrangeByAttention).toHaveAttribute("aria-pressed", "true");
        await expect
          .poll(() =>
            sidebar
              .locator(`[${HEADING}]:visible`)
              .evaluateAll((nodes, attr) => nodes.map((node) => node.getAttribute(attr)), HEADING),
          )
          .toEqual(["Pinned", "Active", "Working", "Snoozed", "Projects", "Settled"]);

        await expandSection(active);
        await expandSection(section(page, "Working"));
        await expandSection(snoozed);
        await expandSection(settled);
        await expectChats(section(page, "Working"), [chats.workingCore, chats.workingProjectless]);
        await expect(
          thread(active, chats.releaseCore).locator("[data-app-action-sidebar-thread-preview]"),
        ).toHaveText(/^Needs your answer/);
        await expectChats(snoozed, [chats.snoozed]);
        await expectChats(settled, initialSettled);
        await expect(
          thread(active, chats.woke).locator('[data-sidebar-status="woke"]'),
        ).toBeVisible();
        await expect(review.locator("[data-app-action-sidebar-thread-preview]")).toHaveText(
          /^Ready for your review/,
        );
        await expect(inbox.getByLabel("3 in Inbox")).toBeVisible();
        await expect(waitingGlyph).toBeVisible();
        await sidebar.evaluate((element) => element.scrollTo(0, 0));
        const screenshot = testInfo.outputPath("sidebar-attention.png");
        await page.screenshot({ path: screenshot, animations: "disabled" });
        await testInfo.attach("sidebar-attention", { path: screenshot, contentType: "image/png" });
        // A Page awaiting review is a decision even when its chat has been read.
        await expect.soft(settleRead).toHaveAttribute("aria-label", "Settle 4 read chats");
      });

      await test.step("scope both chats and Inbox to Core", async () => {
        await expect(arrangeByAttention).toHaveAttribute("aria-pressed", "true");
        // The view options show beside the first heading while it is pointed at.
        const pinned = section(page, "Pinned");
        await pinned.locator("[data-app-action-sidebar-section-toggle]").hover();
        await pinned.getByRole("button", { name: "View options" }).click();
        await page.getByRole("menuitem", { name: /^Chats from/ }).hover();
        await page.locator(`[data-app-action-sidebar-scope-option="${coreProjectId}"]`).click();
        const clearScope = page.getByRole("button", { name: "Showing Core. Show all projects" });
        await expect(clearScope).toBeVisible();
        await expect(inbox.getByLabel("2 in Inbox")).toBeVisible();
        await expect(waitingGlyph).toBeVisible();
        await expectChats(
          sidebar,
          [
            chats.question,
            chats.quietCore,
            chats.workingCore,
            chats.releaseCore,
            chats.settledCore,
          ],
          expect.soft,
        );
        await clearScope.click();
        await expect(inbox.getByLabel("3 in Inbox")).toBeVisible();
        await expect(review).toBeVisible();
      });

      await test.step("accept the review and settle its Active chat", async () => {
        await review.hover();
        await review.getByRole("button", { name: "Accept and settle", exact: true }).click();
        await expect(review).toHaveCount(0);
        await expectChats(settled, [...initialSettled, chats.review]);
        await expect(inbox.getByLabel("2 in Inbox")).toBeVisible();
      });

      await test.step("settle exactly the four read chats and restore them with one Undo", async () => {
        const initialActive = [
          chats.question,
          chats.approval,
          chats.unreadWeb,
          chats.unreadProjectless,
          chats.woke,
          chats.releaseCore,
        ];
        await expectChats(active, [...initialActive, ...quietChats]);
        await active.getByRole("button", { name: "Active", exact: true }).hover();
        await expect(settleRead).toHaveAccessibleName("Settle 4 read chats");
        await settleRead.click();
        await expectChats(active, initialActive);
        const settledAfterReview = [...initialSettled, chats.review];
        await expectChats(settled, [...settledAfterReview, ...quietChats]);
        const undo = page.getByRole("button", { name: "Undo", exact: true });
        await expect(undo).toHaveCount(1);
        await undo.click();
        await expectChats(active, [...initialActive, ...quietChats]);
        await expectChats(settled, settledAfterReview);
      });

      await test.step("snooze a chat from its row", async () => {
        const chat = thread(active, chats.quietWeb);
        await chat.hover();
        const snooze = chat.getByRole("button", { name: "Snooze", exact: true });
        await expect(snooze).toHaveAttribute("data-app-action-sidebar-thread-snooze", "");
        await snooze.click();
        await page.getByRole("menuitem", { name: /^In 1 hour/ }).click();
        await expect(chat).toHaveCount(0);
        await expectChats(snoozed, [chats.snoozed, chats.quietWeb]);
      });
    },
  );
});
