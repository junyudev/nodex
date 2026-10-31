import { expect, test, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  requireSidebarLinkedPageStatusScenarioFacts,
  SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/sidebar-linked-page-status";
import { WORKFLOW_STATUS_LABELS } from "../../src/shared/workflow-status";
import { invokeIpc } from "./support/editor-scenario";

const threadRow = (page: Page, title: string) =>
  page.locator(
    `[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-title="${title}"]:visible`,
  );

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
      }).toPass({ timeout: 15_000 });
      const projectList = page.locator(
        `[data-app-action-sidebar-project-list-id="${manifest.projectId}"]:visible`,
      );
      // Project chat lists initially reveal five rows; this scenario has nine.
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
            name: `Page status: ${WORKFLOW_STATUS_LABELS[chat.expectedStatusOptionId]}`,
            exact: true,
          }),
        ).toBeVisible();
      }

      const buildChat = observed.chats.build;
      const buildPage = observed.pages.build;
      const buildRow = threadRow(page, buildChat.title);
      const hoverCard = page.getByRole("dialog", {
        name: `Chat details for ${buildChat.title}`,
        exact: true,
      });
      // Sidebar layout can still shift after seeding, cancelling the delayed hover.
      // Reacquire the row and keep a real pointer inside it until its card opens.
      await expect(async () => {
        await buildRow.hover();
        const bounds = await buildRow.boundingBox();
        if (!bounds) throw new Error("Build Chat row has no visible bounds");
        await page.mouse.move(bounds.x + bounds.width / 2 + 4, bounds.y + bounds.height / 2, {
          steps: 3,
        });
        await expect(buildRow).toHaveAttribute("data-hover-card-state", "open", {
          timeout: 2_000,
        });
        await expect(hoverCard).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 10_000 });
      const linkedPage = hoverCard.locator(
        `button[data-app-action-sidebar-thread-hover-card-linked-page="${buildPage.pageId}"]`,
      );
      await expect(linkedPage).toContainText(buildPage.title);
      await linkedPage.click();
      const pageStage = page.locator(
        `[data-page-stage-page-id="${buildPage.pageId}"][data-page-stage-surface="true"]:visible`,
      );
      await expect(pageStage).toBeVisible();
      await expect(pageStage.getByRole("textbox", { name: "Page title", exact: true })).toHaveText(
        buildPage.title,
      );

      await pageStage.getByRole("button", { name: "Edit Status", exact: true }).click();
      await page.getByRole("option", { name: "Ship", exact: true }).click();
      await page.mouse.move(1000, 900);
      await expect(
        buildRow.locator("[data-app-action-sidebar-thread-page-status]"),
      ).toHaveAttribute("data-app-action-sidebar-thread-page-status", "ship");
      await expect(
        threadRow(page, observed.chats.pinnedBuild.title).locator(
          "[data-app-action-sidebar-thread-page-status]",
        ),
      ).toHaveAttribute("data-app-action-sidebar-thread-page-status", "ship");
      await expect(
        threadRow(page, observed.chats.multiple.title).locator(
          "[data-app-action-sidebar-thread-page-status]",
        ),
      ).toHaveAttribute("data-app-action-sidebar-thread-page-status", "ship");

      const multipleChat = observed.chats.multiple;
      const multipleStatus = threadRow(page, multipleChat.title).locator(
        "[data-app-action-sidebar-thread-page-status]",
      );
      await invokeIpc(page, "page-chats:unlink", multipleChat.sessionId, {
        pageId: buildPage.pageId,
      });
      await expect(multipleStatus).toHaveAttribute(
        "data-app-action-sidebar-thread-page-status",
        "review",
      );

      await invokeIpc(page, "page-chats:unlink", buildChat.sessionId, {
        pageId: buildPage.pageId,
      });
      await expect
        .poll(async () => {
          const linked = await seed.readPageChats(buildPage.pageId);
          return linked.items.some((chat) => chat.sessionId === buildChat.sessionId);
        })
        .toBe(false);
      await expect(buildRow).toBeVisible();
      await expect(buildRow.locator("[data-app-action-sidebar-thread-page-status]")).toHaveCount(0);
      await expect(
        threadRow(page, observed.chats.pinnedBuild.title).locator(
          "[data-app-action-sidebar-thread-page-status]",
        ),
      ).toHaveAttribute("data-app-action-sidebar-thread-page-status", "ship");
    },
  );
});
