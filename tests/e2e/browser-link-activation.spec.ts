import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  browserPageHtml,
  browserTab,
  clickInBrowserPage,
  openBrowserPage,
  startBrowserSite,
  visibleBrowserGuest,
} from "./support/browser-page";

const linkStyle = "display:block;height:44px;line-height:44px;padding:0 12px";

const PAGES = {
  "/links": browserPageHtml(
    "Link source",
    [
      `<a id="same-tab" style="${linkStyle}" href="/same-tab">Same tab</a>`,
      `<a id="blank-target" style="${linkStyle}" href="/blank-target" target="_blank">New tab</a>`,
      `<a id="modified" style="${linkStyle}" href="/modified">Modified click</a>`,
      `<button id="script-open" style="${linkStyle}" onclick="window.open('/script-open')">Script</button>`,
    ].join(""),
  ),
  "/same-tab": browserPageHtml("Same tab page"),
  "/blank-target": browserPageHtml("Blank target page"),
  "/modified": browserPageHtml("Modified click page"),
  "/script-open": browserPageHtml("Script opened page"),
};

test("Links in a Browser page open where the page asked @automatic", async () => {
  const site = await startBrowserSite(PAGES);
  try {
    await withElectronScenario(
      { label: "browser-link-activation", scenarioId: null, prepareAgentRuntime: false },
      async ({ harness, page }) => {
        await openBrowserPage(page, `${site.origin}/links`);
        const source = browserTab(page, "Link source");
        await expect(source).toBeVisible();
        await expect(visibleBrowserGuest(page)).toBeVisible();
        const click = (elementId: string, modifiers?: Array<"Meta" | "Control">) =>
          clickInBrowserPage(harness, page, visibleBrowserGuest(page), elementId, modifiers);

        // Each new tab is named by its page, which also proves Browser state settles: the
        // title only reaches the tab once Main stops broadcasting.
        await click("blank-target");
        await expect(browserTab(page, "Blank target page")).toHaveAttribute(
          "aria-selected",
          "true",
        );

        await source.click();
        await click("script-open");
        await expect(browserTab(page, "Script opened page")).toHaveAttribute(
          "aria-selected",
          "true",
        );

        await source.click();
        await click("modified", [process.platform === "darwin" ? "Meta" : "Control"]);
        await expect(browserTab(page, "Modified click page")).toBeVisible();
        await expect(source).toHaveAttribute("aria-selected", "true");

        await click("same-tab");
        await expect(browserTab(page, "Same tab page")).toHaveAttribute("aria-selected", "true");
        await expect(source).toHaveCount(0);
      },
    );
  } finally {
    await site.close();
  }
});
