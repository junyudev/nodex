import { expect, test, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  requireSidebarLinkedPageStatusScenarioFacts,
  SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/sidebar-linked-page-status";
import { DEFAULT_WORKFLOW_STATUS_LABELS } from "../../src/shared/workflow-status";
import { invokeIpc } from "./support/editor-scenario";

const threadRow = (page: Page, title: string) =>
  page.locator(
    `[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-title="${title}"]:visible`,
  );

const openThreadHoverCard = async (page: Page, title: string) => {
  const row = threadRow(page, title);
  const hoverCard = page.getByRole("dialog", {
    name: `Chat details for ${title}`,
    exact: true,
  });
  // Sidebar layout can still shift after seeding, cancelling the delayed hover.
  // Reacquire the row and keep a real pointer inside it until its card opens.
  await expect(async () => {
    await page.mouse.move(1000, 900);
    await row.hover();
    const bounds = await row.boundingBox();
    if (!bounds) throw new Error(`Chat row "${title}" has no visible bounds`);
    await page.mouse.move(bounds.x + bounds.width / 2 + 4, bounds.y + bounds.height / 2, {
      steps: 3,
    });
    // oxlint-disable-next-line nodex/no-explicit-test-timeout -- Bound each retry attempt inside toPass() so a cancelled hover timer retries cleanly.
    await expect(row).toHaveAttribute("data-hover-card-state", "open", { timeout: 2_000 });
    await expect(hoverCard).toBeVisible({ timeout: 2_000 });
  }).toPass();
  return hoverCard;
};

test("shows the earliest linked Page's Status, opens the Page, and follows live Status and link changes", async ({}, testInfo) => {
  test.setTimeout(180_000);
  let captureWindow: (() => Promise<Buffer>) | undefined;
  await withElectronScenario(
    {
      label: "sidebar-linked-page-status",
      scenarioId: SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("sidebar-linked-page-status-runtime-logs", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const hoverState = await page?.evaluate(() => ({
          references: [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].map(
            (row) => ({
              title: row.getAttribute("data-app-action-sidebar-thread-title"),
              state: row.getAttribute("data-hover-card-state"),
              bounds: row.getBoundingClientRect().toJSON(),
            }),
          ),
          cards: [...document.querySelectorAll('[data-slot="hover-card-content"]')].map((card) => ({
            label: card.getAttribute("aria-label"),
            role: card.getAttribute("role"),
            text: card.textContent,
            bounds: card.getBoundingClientRect().toJSON(),
          })),
        }));
        await testInfo.attach("sidebar-linked-page-status-hover-state", {
          body: JSON.stringify(hoverState ?? null, null, 2),
          contentType: "application/json",
        });
        const screenshot =
          (await captureWindow?.().catch(() => null)) ??
          (await page?.screenshot({ fullPage: true }).catch(() => null));
        if (!screenshot) return;
        await testInfo.attach("sidebar-linked-page-status-failure", {
          body: screenshot,
          contentType: "image/png",
        });
      },
    },
    async ({ application, facts, manifest, page, seed }) => {
      if (!manifest || !facts) throw new Error("Sidebar linked Page scenario did not materialize");
      captureWindow = async () => {
        const png = await application.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          if (!window) throw new Error("Scenario window is unavailable");
          return (await window.webContents.capturePage()).toPNG().toString("base64");
        });
        return Buffer.from(png, "base64");
      };
      const observed = requireSidebarLinkedPageStatusScenarioFacts(facts);
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });

      const projectRow = page.locator(
        `[data-app-action-sidebar-project-id="${manifest.projectId}"]:visible`,
      );
      await expect(async () => {
        await projectRow.hover();
        const expand = projectRow.getByRole("button", { name: "Expand project", exact: true });
        if (await expand.count()) await expand.click({ timeout: 1_000 });
        await expect(
          page.locator(`[data-app-action-sidebar-project-list-id="${manifest.projectId}"]:visible`),
        ).toBeVisible({ timeout: 1_000 });
      }).toPass();
      const projectList = page.locator(
        `[data-app-action-sidebar-project-list-id="${manifest.projectId}"]:visible`,
      );
      // Project chat lists initially reveal five rows; reveal the remaining fixture chats.
      await projectList.getByRole("button", { name: "Show more", exact: true }).click();
      await page.mouse.move(1000, 900);

      for (const chat of Object.values(observed.chats)) {
        const row = threadRow(page, chat.title);
        await expect(row).toBeVisible();
        const status = row.locator("[data-app-action-sidebar-thread-page-status]");
        if (chat.expectedStatusOptionId === null) {
          await expect(status).toHaveCount(0);
          continue;
        }
        await expect(status).toHaveAttribute(
          "data-app-action-sidebar-thread-page-status",
          chat.expectedStatusOptionId,
        );
        await expect(
          status.getByRole("img", {
            name: `Page status: ${DEFAULT_WORKFLOW_STATUS_LABELS[chat.expectedStatusOptionId]}`,
            exact: true,
          }),
        ).toBeVisible();
      }

      const doingChat = observed.chats.doing;
      const doingPage = observed.pages.doing;
      const doingRow = threadRow(page, doingChat.title);
      const hoverCard = await openThreadHoverCard(page, doingChat.title);
      const linkedPage = hoverCard.locator(
        `button[data-app-action-sidebar-thread-hover-card-linked-page="${doingPage.pageId}"]`,
      );
      await expect(linkedPage).toContainText(doingPage.title);
      await expect(linkedPage).not.toContainText("In Progress");

      // Change the linked Page's Status directly from the hover card's leading Status glyph.
      const hoverStatusButton = hoverCard.locator(
        `button[data-app-action-sidebar-thread-hover-card-linked-page-status="${doingPage.pageId}"]`,
      );
      await expect(hoverStatusButton).toHaveAttribute(
        "aria-label",
        `Change status for ${doingPage.title}: In Progress`,
      );
      await hoverStatusButton.click();
      await page.getByRole("option", { name: "In Review", exact: true }).click();
      await expect(
        doingRow.locator("[data-app-action-sidebar-thread-page-status]"),
      ).toHaveAttribute("data-app-action-sidebar-thread-page-status", "review");
      await expect(hoverStatusButton).toHaveAttribute("data-status-option-id", "review");
      await expect(hoverStatusButton).toHaveAttribute(
        "aria-label",
        `Change status for ${doingPage.title}: In Review`,
      );
      await expect(linkedPage).not.toContainText("In Review");

      // Jump to the chat's Project Scene by clicking the Project row inside the hover card.
      const hoverProjectButton = hoverCard.locator(
        "button[data-app-action-sidebar-thread-hover-card-project]",
      );
      await hoverProjectButton.click();
      await expect(hoverCard).toBeHidden();
      await expect(
        page.locator(
          `[data-app-action-sidebar-project-id="${manifest.projectId}"][data-active="true"]`,
        ),
      ).toBeVisible();

      // Reopen the hover card and open the linked Page beside the chat.
      const reopenedCard = await openThreadHoverCard(page, doingChat.title);
      await reopenedCard
        .locator(
          `button[data-app-action-sidebar-thread-hover-card-linked-page="${doingPage.pageId}"]`,
        )
        .click();
      await expect(reopenedCard).toBeHidden();
      const pageStage = page.locator(
        `[data-page-stage-page-id="${doingPage.pageId}"][data-page-stage-surface="true"]:visible`,
      );
      await expect(pageStage).toBeVisible();
      await expect(pageStage.getByRole("textbox", { name: "Page title", exact: true })).toHaveText(
        doingPage.title,
      );

      await pageStage.getByRole("button", { name: "Edit Status", exact: true }).click();
      await page.getByRole("option", { name: "Done", exact: true }).click();
      await page.mouse.move(1000, 900);
      await expect(
        doingRow.locator("[data-app-action-sidebar-thread-page-status]"),
      ).toHaveAttribute("data-app-action-sidebar-thread-page-status", "done");
      await expect(
        threadRow(page, observed.chats.pinnedDoing.title).locator(
          "[data-app-action-sidebar-thread-page-status]",
        ),
      ).toHaveAttribute("data-app-action-sidebar-thread-page-status", "done");
      await expect(
        threadRow(page, observed.chats.multiple.title).locator(
          "[data-app-action-sidebar-thread-page-status]",
        ),
      ).toHaveAttribute("data-app-action-sidebar-thread-page-status", "done");

      const multipleChat = observed.chats.multiple;
      const multipleStatus = threadRow(page, multipleChat.title).locator(
        "[data-app-action-sidebar-thread-page-status]",
      );
      await invokeIpc(page, "page-chats:unlink", multipleChat.sessionId, {
        pageId: doingPage.pageId,
      });
      await expect(multipleStatus).toHaveAttribute(
        "data-app-action-sidebar-thread-page-status",
        "review",
      );

      await invokeIpc(page, "page-chats:unlink", doingChat.sessionId, {
        pageId: doingPage.pageId,
      });
      await expect
        .poll(async () => {
          const linked = await seed.readPageChats(doingPage.pageId);
          return linked.items.some((chat) => chat.sessionId === doingChat.sessionId);
        })
        .toBe(false);
      await expect(doingRow).toBeVisible();
      await expect(doingRow.locator("[data-app-action-sidebar-thread-page-status]")).toHaveCount(0);
      await expect(
        threadRow(page, observed.chats.pinnedDoing.title).locator(
          "[data-app-action-sidebar-thread-page-status]",
        ),
      ).toHaveAttribute("data-app-action-sidebar-thread-page-status", "done");

      // An unlinked non-active chat offers "New page" at the bottom of its hover card, creating
      // and linking a Page titled after the chat and pre-opening it in that chat's right panel
      // without leaving the active chat, keeping the hover card open as it updates live.
      const unlinkedChat = observed.chats.unlinked;
      const unlinkedRow = threadRow(page, unlinkedChat.title);
      const unlinkedCard = await openThreadHoverCard(page, unlinkedChat.title);
      const newPageButton = unlinkedCard.locator(
        "button[data-app-action-sidebar-thread-hover-card-new-page]",
      );
      await expect(newPageButton).toBeVisible();
      await expect(newPageButton).toHaveText("New page");
      await newPageButton.click();

      await expect(unlinkedCard).toBeVisible();
      await expect(newPageButton).toHaveCount(0);
      const createdUnlinkedRow = unlinkedCard.locator(
        "button[data-app-action-sidebar-thread-hover-card-linked-page]",
      );
      await expect(createdUnlinkedRow).toContainText(unlinkedChat.title);
      await expect(createdUnlinkedRow).not.toContainText("Triage");
      await expect(
        unlinkedCard.locator(
          "button[data-app-action-sidebar-thread-hover-card-linked-page-status]",
        ),
      ).toHaveAttribute("data-status-option-id", "triage");
      await expect(
        unlinkedRow.locator("[data-app-action-sidebar-thread-page-status]"),
      ).toHaveAttribute("data-app-action-sidebar-thread-page-status", "triage");
      await expect(doingRow).toHaveAttribute("data-app-action-sidebar-thread-active", "true");
      await expect(unlinkedRow).toHaveAttribute("data-app-action-sidebar-thread-active", "false");

      // Hovering the active, now-unlinked chat and clicking "New page" dismisses its hover card
      // and opens the new Page titled after that chat right beside it with the title focused.
      await page.mouse.move(1000, 900);
      await expect(unlinkedCard).toBeHidden();
      const activeDoingCard = await openThreadHoverCard(page, doingChat.title);
      const activeNewPageButton = activeDoingCard.locator(
        "button[data-app-action-sidebar-thread-hover-card-new-page]",
      );
      await expect(activeNewPageButton).toBeVisible();
      await activeNewPageButton.click();
      await expect(activeDoingCard).toBeHidden();

      const activeCreatedStage = page.locator('[data-page-stage-surface="true"]:visible');
      await expect(activeCreatedStage).toBeVisible();
      const activeCreatedTitle = activeCreatedStage.getByRole("textbox", {
        name: "Page title",
        exact: true,
      });
      await expect(activeCreatedTitle).toHaveText(doingChat.title);
      await expect(activeCreatedTitle).toBeFocused();
      await expect(
        doingRow.locator("[data-app-action-sidebar-thread-page-status]"),
      ).toHaveAttribute("data-app-action-sidebar-thread-page-status", "triage");

      // Switching to the non-active chat reveals the Page pre-opened in its right panel.
      await unlinkedRow.click();
      await expect(unlinkedRow).toHaveAttribute("data-app-action-sidebar-thread-active", "true");
      const preopenedPageStage = page.locator('[data-page-stage-surface="true"]:visible');
      await expect(preopenedPageStage).toBeVisible();
      await expect(
        preopenedPageStage.getByRole("textbox", { name: "Page title", exact: true }),
      ).toHaveText(unlinkedChat.title);
    },
  );
});
