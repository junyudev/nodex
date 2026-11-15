import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  browserGuestId,
  browserPageHtml,
  browserTab,
  clickAboveBrowserPage,
  openBrowserPage,
  startBrowserSite,
  visibleBrowserGuest,
} from "./support/browser-page";

const buttonStyle = "display:block;height:44px;padding:0 12px";

const PAGES = {
  "/dialogs": browserPageHtml(
    "Dialog source",
    [
      `<button id="confirm" style="${buttonStyle}" onclick="document.title = confirm('Delete it?') ? 'Confirmed' : 'Declined'">Confirm</button>`,
      `<button id="alert" style="${buttonStyle}" onclick="alert('Saved'); document.title = 'Alerted'">Alert</button>`,
    ].join(""),
  ),
};

test("A Browser page's dialog is answered in its tab, by a person or an Agent @automatic", async () => {
  const site = await startBrowserSite(PAGES);
  try {
    await withElectronScenario(
      { label: "browser-page-dialogs", scenarioId: null, prepareAgentRuntime: false },
      async ({ harness, page }) => {
        // Playwright dismisses a dialog nothing claims; these are Nodex's to answer.
        harness.application.context().on("dialog", () => undefined);
        await openBrowserPage(page, `${site.origin}/dialogs`);
        await expect(browserTab(page, "Dialog source")).toBeVisible();
        const guest = visibleBrowserGuest(page);
        await expect(guest).toBeVisible();
        const guestId = await browserGuestId(guest);
        // The page's handler does not return until the dialog is answered, so it is started
        // without waiting. A pointer click would hold the window's input queue the same way.
        const ask = async (elementId: string) =>
          await harness.application.evaluate(
            ({ webContents }, input) => {
              void webContents
                .fromId(input.guestId)
                ?.executeJavaScript(
                  `document.getElementById(${JSON.stringify(input.elementId)}).click()`,
                  true,
                );
            },
            { guestId, elementId },
          );
        const dialog = page.getByRole("alertdialog", { name: `${site.host} says` });

        // The page waits on the person, and gets the answer they gave.
        await ask("confirm");
        await expect(dialog).toContainText("Delete it?");
        await expect(browserTab(page, "Dialog source")).toBeVisible();
        await clickAboveBrowserPage(
          page,
          dialog.getByRole("button", { name: "Cancel", exact: true }),
        );
        await expect(browserTab(page, "Declined")).toBeVisible();
        await expect(dialog).toHaveCount(0);

        // A page that asks again can be told to stop, and still gets this answer.
        await ask("confirm");
        await expect(
          dialog.getByRole("checkbox", { name: "Don’t let this page open more dialogs" }),
        ).toBeVisible();
        await clickAboveBrowserPage(page, dialog.getByRole("button", { name: "OK", exact: true }));
        await expect(browserTab(page, "Confirmed")).toBeVisible();

        await ask("alert");
        await expect(dialog).toContainText("Saved");
        await dialog.getByRole("button", { name: "OK", exact: true }).press("Enter");
        await expect(browserTab(page, "Alerted")).toBeVisible();

        // An Agent answers the same dialog through its own page session, and the tab lets go.
        await harness.application.evaluate(async ({ webContents }, id) => {
          const contents = webContents.fromId(id);
          if (!contents) throw new Error("Missing Browser page");
          if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
          await contents.debugger.sendCommand("Page.enable");
        }, guestId);
        await ask("confirm");
        await expect(dialog).toContainText("Delete it?");
        await harness.application.evaluate(async ({ webContents }, id) => {
          await webContents
            .fromId(id)
            ?.debugger.sendCommand("Page.handleJavaScriptDialog", { accept: false });
        }, guestId);
        await expect(browserTab(page, "Declined")).toBeVisible();
        await expect(dialog).toHaveCount(0);

        // A page that is not showing waits for the person, and its tab says so.
        await page.getByRole("button", { name: "New tab", exact: true }).click();
        const background = browserTab(page, "Declined");
        await expect(background).toHaveAttribute("aria-selected", "false");
        await ask("alert");
        const mark = "[data-browser-tab-awaits-answer]";
        await expect(background.locator(mark)).toBeVisible();
        await background.click();
        await expect(dialog).toContainText("Saved");
        await clickAboveBrowserPage(page, dialog.getByRole("button", { name: "OK", exact: true }));
        const answered = browserTab(page, "Alerted");
        await expect(answered).toBeVisible();
        await expect(answered.locator(mark)).toHaveCount(0);
      },
    );
  } finally {
    await site.close();
  }
});
