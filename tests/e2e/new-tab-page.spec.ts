import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { landingShowcaseScenario } from "../../scripts/scenarios/scenarios/landing-showcase";

test("replaces Project New tabs with Pages and keeps the action menu on right-click", async ({}, testInfo) => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: "new-tab-page",
      scenarioId: landingShowcaseScenario.id,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("new-tab-page-runtime-logs", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
        if (!screenshot) return;
        await testInfo.attach("new-tab-page-failure", {
          body: screenshot,
          contentType: "image/png",
        });
      },
    },
    async ({ application, page, manifest }) => {
      if (!manifest) throw new Error("landing/showcase did not materialize");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });
      await page.getByRole("button", { name: "Open Tinyboard", exact: true }).click();
      const scene = page.locator(`[data-workbench-scene-owner="project:${manifest.projectId}"]`);
      await expect(scene).toBeVisible();
      const group = scene.getByTestId("project-right-panel").locator("[data-panel-group-leaf-id]");
      const newTabButton = page.getByRole("button", { name: "New tab", exact: true });
      // Full-width Project tab strips are mounted in the window title bar.
      const tabRow = page.locator("[data-panel-tab-row]").filter({
        has: page.getByRole("tab", { name: "Inbox", exact: true }),
      });
      const tabs = tabRow.getByRole("tab");
      const newTab = tabRow.getByRole("tab", { name: "New tab", exact: true });
      const newTabPage = group.locator("[data-new-tab-scroll-root]");
      const readNewTabIndex = async (): Promise<number> => {
        const labels = await tabs.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label")),
        );
        const index = labels.indexOf("New tab");
        expect(index).toBeGreaterThanOrEqual(0);
        return index;
      };
      await expect(tabRow.getByRole("tab", { name: "Inbox", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      const initialTabCount = await tabs.count();

      await test.step("opens a selected New tab with Tools and Recents", async () => {
        await newTabButton.click();
        await expect(newTab).toHaveAttribute("aria-selected", "true");
        await expect(tabs).toHaveCount(initialTabCount + 1);
        await expect(newTabPage.getByRole("heading", { name: "Tools", exact: true })).toBeVisible();
        await expect(
          newTabPage.getByRole("button", { name: "New page", exact: true }),
        ).toBeVisible();
        await expect(
          newTabPage.getByRole("heading", { name: "Recents", exact: true }),
        ).toBeVisible();
        await expect(newTabPage.getByRole("list", { name: "Recent pages" })).toBeVisible();
      });

      await test.step("creates a Page in place and selects its title for typing", async () => {
        const newTabIndex = await readNewTabIndex();
        await newTabPage.getByRole("button", { name: "New page", exact: true }).click();
        await expect(newTab).toHaveCount(0);
        await expect(tabs).toHaveCount(initialTabCount + 1);
        await expect(tabs.nth(newTabIndex)).toHaveAccessibleName(/Untitled/u);
        await expect(tabs.nth(newTabIndex)).toHaveAttribute("aria-selected", "true");
        const title = group.getByRole("textbox", { name: "Page title", exact: true });
        await expect(title).toHaveText("Untitled");
        await expect(title).toBeFocused();
        // Typing without filling or selecting proves that the initial title was selected.
        await page.keyboard.type("Draft notes");
        await expect(title).toHaveText("Draft notes");
      });

      await test.step("opens a recent Page in the same tab position", async () => {
        await newTabButton.click();
        await expect(newTab).toHaveAttribute("aria-selected", "true");
        await expect(tabs).toHaveCount(initialTabCount + 2);
        const newTabIndex = await readNewTabIndex();
        await newTabPage
          .getByRole("list", { name: "Recent pages" })
          .getByRole("button", { name: "Keyboard shortcuts", exact: true })
          .click();
        await expect(newTab).toHaveCount(0);
        await expect(tabs).toHaveCount(initialTabCount + 2);
        await expect(tabs.nth(newTabIndex)).toHaveAccessibleName(/Keyboard shortcuts/u);
        await expect(tabs.nth(newTabIndex)).toHaveAttribute("aria-selected", "true");
        await expect(group.getByRole("textbox", { name: "Page title", exact: true })).toHaveText(
          "Keyboard shortcuts",
        );
      });

      await test.step("opens the action menu on right-click and dismisses it with Escape", async () => {
        await newTabButton.click({ button: "right" });
        const menu = page.getByRole("menu");
        await expect(menu.getByRole("menuitem", { name: "New page", exact: true })).toBeVisible();
        await expect(newTab).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
      });
    },
  );
});
