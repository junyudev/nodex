import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { openSpace } from "../../scripts/scenarios/harness/space-ui";
import {
  requireWindowTitlesScenarioFacts,
  WINDOW_TITLES_CONTENT as CONTENT,
  WINDOW_TITLES_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/window-titles";

/** macOS titles name the content alone; Windows and Linux end them with the application. */
const nativeTitle = (...parts: string[]): string =>
  [...parts, ...(process.platform === "darwin" ? [] : ["Nodex"])].join(" — ");

const readNativeTitle = async (application: ElectronApplication, page: Page): Promise<string> =>
  await (await application.browserWindow(page)).evaluate((window) => window.getTitle());

const expectNativeTitle = async (
  application: ElectronApplication,
  page: Page,
  title: string,
): Promise<void> => {
  await expect.poll(() => readNativeTitle(application, page)).toBe(title);
};

const appNavigation = (page: Page) =>
  page.getByRole("navigation", { name: "App navigation", exact: true });

const openChat = async (page: Page, projectId: string, title: string): Promise<void> => {
  await appNavigation(page).getByRole("button", { name: "Home", exact: true }).click();
  const projectRow = page.locator(`[data-app-action-sidebar-project-id="${projectId}"]:visible`);
  const chatRow = page.locator(`[data-app-action-sidebar-thread-title="${title}"]:visible`);
  await expect(async () => {
    if (await chatRow.count()) return;
    await projectRow.hover();
    await projectRow.getByRole("button", { name: "Expand project", exact: true }).click({
      timeout: 1_000,
    });
    await expect(chatRow).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await chatRow.click();
};

const spaceContentRow = (page: Page, title: string) =>
  page
    .getByRole("navigation", { name: "Space", exact: true })
    .getByRole("list", { name: "Content", exact: true })
    .getByRole("listitem")
    .filter({ hasText: title });

test("each window is named after what it shows, and follows its content live", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withElectronScenario(
    {
      label: "window-titles",
      scenarioId: WINDOW_TITLES_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("window-titles-runtime-logs", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
        if (screenshot) {
          await testInfo.attach("window-titles-failure", {
            body: screenshot,
            contentType: "image/png",
          });
        }
      },
    },
    async ({ application, facts, page }) => {
      const observed = requireWindowTitlesScenarioFacts(facts);
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
      });
      // Review evidence: capture once short transitions such as a Project expanding settle.
      const capture = async (target: Page, name: string): Promise<void> => {
        await target.mouse.move(1_200, 700);
        await expect
          .poll(() =>
            target.evaluate(
              () =>
                document
                  .getAnimations()
                  .filter(
                    (animation) =>
                      animation.playState === "running" &&
                      Number(animation.effect?.getComputedTiming().activeDuration) <= 1_000,
                  ).length,
            ),
          )
          .toBe(0);
        await target.screenshot({ path: testInfo.outputPath(`${name}.png`) });
      };

      // A chat is named before the Project it belongs to.
      await openChat(page, observed.primaryProjectId, CONTENT.primaryChat);
      await expect(
        page.locator(
          `[data-workbench-scene-owner="session:${observed.primaryChatSessionId}"]:visible`,
        ),
      ).toBeVisible();
      await expectNativeTitle(
        application,
        page,
        nativeTitle(CONTENT.primaryChat, CONTENT.primaryProject),
      );
      await capture(page, "chat");

      // A Project Scene is named by its Project.
      await page
        .getByRole("button", { name: `Open ${CONTENT.primaryProject}`, exact: true })
        .click();
      await expectNativeTitle(application, page, nativeTitle(CONTENT.primaryProject));
      await capture(page, "project");

      // Space is named by its active surface, and follows the Page's title as it is edited.
      await openSpace(page);
      await spaceContentRow(page, CONTENT.spacePage).click();
      await expect(page.getByRole("tab", { name: CONTENT.spacePage, exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expectNativeTitle(application, page, nativeTitle(CONTENT.spacePage));
      const renamedPage = `${CONTENT.spacePage} draft`;
      await page.getByRole("textbox", { name: "Page title" }).fill(renamedPage);
      await expectNativeTitle(application, page, nativeTitle(renamedPage));
      await capture(page, "space-page");

      // Destinations without an owner use their own name, and leaving restores the content.
      await page.getByRole("button", { name: "Spaces and settings", exact: true }).click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      await expectNativeTitle(application, page, nativeTitle("Settings"));
      await capture(page, "settings");
      await page.getByRole("button", { name: "Back to app", exact: true }).click();
      await expectNativeTitle(application, page, nativeTitle(renamedPage));

      // Every window keeps its own title.
      const opened = application.waitForEvent("window");
      await application.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById("file.newWindow");
        if (!item) throw new Error("New Window menu item is unavailable");
        item.click();
      });
      const secondPage = await opened;
      await secondPage.waitForLoadState("domcontentloaded");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.isFocused())
          ?.setBounds({ x: 80, y: 60, width: 1440, height: 900 });
      });
      await openChat(secondPage, observed.secondaryProjectId, CONTENT.secondaryChat);
      await expect(
        secondPage.locator(
          `[data-workbench-scene-owner="session:${observed.secondaryChatSessionId}"]:visible`,
        ),
      ).toBeVisible();
      await expectNativeTitle(
        application,
        secondPage,
        nativeTitle(CONTENT.secondaryChat, CONTENT.secondaryProject),
      );
      await capture(secondPage, "second-window-chat");
      expect(await readNativeTitle(application, page)).toBe(nativeTitle(renamedPage));

      const windowTitles = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((window) => !window.isDestroyed())
          .map((window) => window.getTitle()),
      );
      expect([...windowTitles].sort()).toEqual(
        [
          nativeTitle(renamedPage),
          nativeTitle(CONTENT.secondaryChat, CONTENT.secondaryProject),
        ].sort(),
      );
      writeFileSync(
        testInfo.outputPath("native-window-titles.json"),
        `${JSON.stringify(windowTitles, null, 2)}\n`,
      );
    },
  );
});
