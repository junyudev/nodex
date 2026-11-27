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
const projectStatus = (page: Page, name: string) =>
  section(page, "Projects")
    .locator(`[data-app-action-sidebar-project-label="${name}"]`)
    .locator("[data-app-action-sidebar-project-status]");

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

test("lists chats in Attention view and applies sidebar actions to their live lanes", async ({}, testInfo) => {
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
      const attentionView = page.getByRole("button", { name: "Attention view", exact: true });
      const attentionViewTip = page.getByRole("dialog", { name: "Attention view" });
      const review = thread(active, chats.review);
      // A chat filed in a Section takes the lane its state puts it in.
      const quietChats = [chats.quietNodex, chats.quietCore, chats.quietWeb, chats.releaseNodex];
      const settleRead = active.locator("[data-app-action-sidebar-settle-read]");
      const initialSettled = [chats.settledCore, chats.settledWeb, chats.settledProjectless];
      const waitingGlyph = inbox.getByLabel("Something in the Inbox waits for your answer");

      await test.step("show the seeded lanes, Page wording, and Library Inbox", async () => {
        // Chats sit under their Projects until the toggle beside Search turns on Attention view.
        // With chats asking for the person, the view's tip points at the toggle until it is used.
        await expect(attentionView).toHaveAttribute("aria-pressed", "false");
        await expect(attentionViewTip).toContainText(
          "Gathers the chats waiting on you from every project into one list.",
        );
        await attentionView.click();
        await expect(attentionView).toHaveAttribute("aria-pressed", "true");
        await expect(attentionViewTip).toBeHidden();
        await expect
          .poll(() =>
            sidebar
              .locator(`[${HEADING}]:visible`)
              .evaluateAll((nodes, attr) => nodes.map((node) => node.getAttribute(attr)), HEADING),
          )
          .toEqual(["Projects", "Pinned", "Active", "Working", "Snoozed", "Settled"]);
        // Each Project is its Inbox: Core's waits on an answer, while Nodex's waiting chat
        // already shows in Active and Web's Inbox holds only a review.
        await expect(
          projectStatus(page, "Core").getByLabel("Something in Core's Inbox waits for your answer"),
        ).toBeVisible();
        await expect(projectStatus(page, "Nodex")).toHaveCount(0);
        await expect(projectStatus(page, "Web")).toHaveCount(0);

        await expandSection(active);
        await expandSection(section(page, "Working"));
        await expandSection(snoozed);
        await expandSection(settled);
        await expectChats(section(page, "Working"), [chats.workingCore, chats.workingProjectless]);
        await expect(
          thread(active, chats.releaseCore).locator("[data-app-action-sidebar-thread-preview]"),
        ).toHaveText(/^Needs your answer/);
        // Chats back by tomorrow name their return; later ones fold behind one row.
        await expectChats(snoozed, [chats.snoozedSoon, chats.snoozed]);
        await expect(
          thread(snoozed, chats.snoozed).locator("[data-app-action-sidebar-thread-wake]"),
        ).toBeVisible();
        await snoozed.getByRole("button", { name: /^2 later · / }).click();
        await expectChats(snoozed, [
          chats.snoozedSoon,
          chats.snoozed,
          chats.snoozedWeek,
          chats.snoozedMonth,
        ]);
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
        await expect(attentionView).toHaveAttribute("aria-pressed", "true");
        // The view options lead the chat lanes without pointing at them.
        await section(page, "Pinned").getByRole("button", { name: "View options" }).click();
        await page.getByRole("menuitem", { name: /^Chats from/ }).hover();
        await page.locator(`[data-app-action-sidebar-scope-option="${coreProjectId}"]`).click();
        const clearScope = page.getByRole("button", { name: "Showing Core. Show all projects" });
        await expect(clearScope).toBeVisible();
        await expect(inbox.getByLabel("2 in Inbox")).toBeVisible();
        await expect(waitingGlyph).toBeVisible();
        // The lanes no longer list Nodex's chats, so its row summarizes them.
        await expect(projectStatus(page, "Nodex")).toHaveAttribute(
          "data-app-action-sidebar-project-status",
          "attention",
        );
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

      await test.step("accept the review, undo it, then accept it for good", async () => {
        const accept = review.getByRole("button", { name: "Accept", exact: true });
        await review.hover();
        await accept.click();
        // Undo within the window means Core never hears of the accept: the review still asks.
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await expect(review.locator("[data-app-action-sidebar-thread-preview]")).toHaveText(
          /^Ready for your review/,
        );
        await review.hover();
        await accept.click();
        // Once the Undo window passes, the work is Done and its Active chat settles.
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
        await expectChats(snoozed, [
          chats.snoozedSoon,
          chats.snoozed,
          chats.quietWeb,
          chats.snoozedWeek,
          chats.snoozedMonth,
        ]);
      });
    },
  );
});
