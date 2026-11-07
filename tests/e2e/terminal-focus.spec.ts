import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import {
  withElectronScenario,
  type ElectronScenarioContext,
} from "../../scripts/scenarios/harness/electron-e2e-harness";

const TOGGLE_TERMINAL = "Control+Backquote";

const terminalInput = (page: Page): Locator =>
  page.getByRole("textbox", { name: "Terminal input" });
const terminalSurface = (page: Page): Locator => page.locator("[data-codex-terminal=true]");
const composer = (page: Page): Locator => page.locator("[data-codex-composer='true']:visible");
const bottomPanelTabs = (page: Page): Locator =>
  page.locator('[data-app-shell-focus-area="bottom-panel"] [role="tab"]');

function withChat(label: string, run: (context: ElectronScenarioContext) => Promise<void>) {
  return withElectronScenario(
    { label, scenarioId: null, windows: "background" },
    async (context) => {
      await context.page.getByRole("button", { name: "New chat", exact: true }).first().click();
      await composer(context.page).click();
      await run(context);
    },
  );
}

/** The desktop accelerator lives on this application-menu item, not in the renderer. */
async function toggleBottomPanel({
  application,
  page,
}: {
  readonly application: ElectronApplication;
  readonly page: Page;
}): Promise<void> {
  await application.evaluate(({ BrowserWindow, Menu }, url) => {
    const target = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === url,
    );
    if (!target) throw new Error("The test window is unavailable");
    const item = Menu.getApplicationMenu()?.getMenuItemById("view.toggleBottomPanel");
    if (!item) throw new Error("The Toggle Bottom Panel menu item is unavailable");
    item.click({ triggeredByAccelerator: true }, target, target.webContents);
  }, page.url());
}

async function openProjectScene(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Home", exact: true })
    .getByRole("button", { name: "Open My Project", exact: true })
    .click();
  await expect(page.locator('[data-inbox-scope="project"]:visible')).toBeVisible();
}

async function typeIntoTerminal(page: Page, command: string): Promise<void> {
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
}

test.describe("Terminal keyboard focus", () => {
  test("the bottom panel toggle moves the cursor into the Terminal and back", async () => {
    await withChat("terminal-focus-toggle", async ({ application, page }) => {
      await toggleBottomPanel({ application, page });
      await expect(terminalInput(page)).toBeFocused();

      // The first keystrokes after the shortcut reach the shell without a click.
      await typeIntoTerminal(page, "echo typed-without-a-click");
      await expect(terminalSurface(page).locator(".xterm-rows")).toContainText(
        "typed-without-a-click",
      );

      // The key leaves the Terminal unconsumed, so the accelerator can still reach the menu.
      await page.evaluate(() => {
        window.addEventListener("keydown", (event) => {
          if (event.key.toLowerCase() === "j") {
            document.documentElement.dataset.toggleKeyConsumed = String(event.defaultPrevented);
          }
        });
      });
      await page.keyboard.press("ControlOrMeta+j");
      await expect(page.locator("html")).toHaveAttribute("data-toggle-key-consumed", "false");

      // The toggle works from inside the Terminal that just took focus.
      await toggleBottomPanel({ application, page });
      await expect(terminalSurface(page)).toHaveCount(0);
      await expect(composer(page)).toBeFocused();
      await page.keyboard.insertText("back in the composer");
      await expect(composer(page)).toContainText("back in the composer");

      // Reopening mounts a fresh renderer for the same session and focuses it too.
      await toggleBottomPanel({ application, page });
      await expect(terminalInput(page)).toBeFocused();
    });
  });

  test("the Terminal shortcut toggles from the composer and from inside the Terminal", async () => {
    await withChat("terminal-focus-shortcut", async ({ page }) => {
      await page.keyboard.press(TOGGLE_TERMINAL);
      await expect(terminalInput(page)).toBeFocused();

      await page.keyboard.press(TOGGLE_TERMINAL);
      await expect(terminalSurface(page)).toHaveCount(0);
      await expect(composer(page)).toBeFocused();

      await page.keyboard.press(TOGGLE_TERMINAL);
      await expect(terminalInput(page)).toBeFocused();
    });
  });

  test("choosing a Terminal tab focuses that Terminal", async () => {
    await withChat("terminal-focus-tabs", async ({ application, page }) => {
      await toggleBottomPanel({ application, page });
      await expect(terminalInput(page)).toBeFocused();
      const firstPanelId = await terminalSurface(page).getAttribute("id");

      await page.keyboard.press("Meta+t");
      await expect(bottomPanelTabs(page)).toHaveCount(2);
      await expect(terminalSurface(page)).not.toHaveAttribute("id", firstPanelId ?? "");
      await expect(terminalInput(page)).toBeFocused();

      await bottomPanelTabs(page).first().click();
      await expect(terminalSurface(page)).toHaveAttribute("id", firstPanelId ?? "");
      await expect(terminalInput(page)).toBeFocused();

      const bottomPanel = page.locator('[data-app-shell-focus-area="bottom-panel"]');
      await bottomPanel.getByRole("button", { name: "New tab", exact: true }).click();
      await bottomPanel.getByRole("button", { name: /^Terminal(?! options)/ }).click();
      await expect(bottomPanelTabs(page)).toHaveCount(3);
      await expect(page.getByRole("tab", { name: "New tab", exact: true })).toHaveCount(0);
      await expect(terminalInput(page)).toBeFocused();
    });
  });

  test("a Terminal that merely mounts leaves the cursor alone", async () => {
    await withElectronScenario(
      { label: "terminal-focus-scene-switch", scenarioId: null, windows: "background" },
      async ({ application, page }) => {
        await openProjectScene(page);
        await toggleBottomPanel({ application, page });
        await expect(terminalInput(page)).toBeFocused();

        // Coming back to the Scene mounts its Terminal again without anyone asking for it.
        await page.getByRole("button", { name: "New chat", exact: true }).first().click();
        await expect(terminalSurface(page)).toHaveCount(0);
        await openProjectScene(page);
        await expect(terminalSurface(page).locator(".xterm-screen")).toBeVisible();
        await expect(terminalInput(page)).not.toBeFocused();
      },
    );
  });

  test("a Terminal that exits hands the cursor on", async () => {
    await withChat("terminal-focus-exit", async ({ application, page }) => {
      await toggleBottomPanel({ application, page });
      await expect(terminalInput(page)).toBeFocused();
      await page.keyboard.press("Meta+t");
      await expect(bottomPanelTabs(page)).toHaveCount(2);
      await expect(terminalInput(page)).toBeFocused();
      const secondPanelId = await terminalSurface(page).getAttribute("id");

      await typeIntoTerminal(page, "exit");
      await expect(bottomPanelTabs(page)).toHaveCount(1);
      await expect(terminalSurface(page)).not.toHaveAttribute("id", secondPanelId ?? "");
      await expect(terminalInput(page)).toBeFocused();

      await typeIntoTerminal(page, "exit");
      await expect(terminalSurface(page)).toHaveCount(0);
      await expect(composer(page)).toBeFocused();
    });
  });

  test("the command palette hands focus to the Terminal it opens", async () => {
    await withChat("terminal-focus-palette", async ({ page }) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByRole("combobox").fill("Toggle bottom panel");
      await page.keyboard.press("Enter");
      await expect(terminalInput(page)).toBeFocused();
    });
  });

  test("a Project Scene's first Terminal takes focus", async () => {
    await withElectronScenario(
      { label: "terminal-focus-project", scenarioId: null, windows: "background" },
      async ({ application, page }) => {
        await openProjectScene(page);

        await toggleBottomPanel({ application, page });
        await expect(terminalInput(page)).toBeFocused();

        await toggleBottomPanel({ application, page });
        await expect(terminalSurface(page)).toHaveCount(0);
      },
    );
  });
});
