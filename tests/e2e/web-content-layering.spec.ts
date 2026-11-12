import { expect, test, type Locator } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { DEFAULT_CODEX_HOST_ID } from "../../src/shared/codex-host";
import type { IpcEvents } from "../../src/shared/ipc-api";
import { readbackId } from "../../src/shared/readback";
import { startBrowserHttpFixture } from "./support/browser-http-fixture";
import { invokeIpc } from "./support/editor-scenario";

/** Hit-tests the centre of an app surface that overlaps a Browser page. */
async function expectAboveWebContent(overlay: Locator, name: string) {
  const hit = await overlay.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const elements = document.elementsFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    const top = elements[0];
    return {
      overlapsGuest: elements.some((candidate) => candidate.localName === "webview"),
      topmost: top && element.contains(top) ? "overlay" : (top?.localName ?? null),
    };
  });

  expect(hit.overlapsGuest, `${name} overlaps the Browser page`).toBe(true);
  expect(hit.topmost, `${name} wins the hit test above the Browser page`).toBe("overlay");
}

test("App surfaces that overlap a Browser page sit above its content @automatic", async () => {
  const title = "Web content layering fixture";
  const site = await startBrowserHttpFixture(title);
  try {
    await withElectronScenario(
      { label: "web-content-layering", scenarioId: null, prepareAgentRuntime: false },
      async ({ harness, page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.getByRole("button", { name: "New tab", exact: true }).click();
        const address = page.getByRole("combobox", { name: "Search or enter a URL" });
        await address.fill(site.url);
        await address.press("Enter");
        await expect(page.getByRole("tab", { name: title, exact: true })).toBeVisible();

        const webview = page.locator(
          '[data-browser-sidebar-webview-manager-root][data-browser-sidebar-webview-host-kind="panel"]:visible webview',
        );
        await expect(webview).toBeVisible();
        const bounds = await webview.boundingBox();
        expect(bounds?.width ?? 0).toBeGreaterThan(200);
        expect(bounds?.height ?? 0).toBeGreaterThan(200);

        await page.getByRole("button", { name: "Annotate", exact: true }).click();
        const annotationMode = page.getByRole("button", { name: "Region", exact: true });
        await expect(annotationMode).toBeVisible();
        await expectAboveWebContent(annotationMode, "the annotation composer");
        await page.getByRole("button", { name: "Exit comment mode", exact: true }).click();

        await page.getByRole("button", { name: "Browser options", exact: true }).click();
        await page.getByRole("menuitem", { name: "Show device toolbar", exact: true }).click();
        const resizeHandle = page.getByRole("button", { name: "Widen viewport", exact: true });
        await expect(resizeHandle).toBeAttached();
        await expectAboveWebContent(resizeHandle, "the viewport resize handle");
        await page.getByRole("button", { name: "Browser options", exact: true }).click();
        await page.getByRole("menuitem", { name: "Hide device toolbar", exact: true }).click();

        const { spaceId } = await invokeIpc(page, "spaces:context");
        const sessionId = "background-session";
        const threadId = "background-thread";
        const runId = "background-run";
        const event: IpcEvents["readback:event"] = {
          type: "show",
          spaceId,
          readback: {
            id: readbackId(sessionId, runId),
            sessionId,
            threadId,
            runId,
            itemId: "opening-message",
            title: "Background chat",
            text: "I’ll review the Browser tab behavior and check that other workspace surfaces remain visible and interactive while the page is open.",
            createdAt: Date.now(),
            navigation: {
              hostId: DEFAULT_CODEX_HOST_ID,
              conversationId: threadId,
              navigationPath: `session:${sessionId}/thread:${threadId}`,
              activateTabId: null,
            },
          },
        };
        // Exercise the real Main-to-renderer delivery boundary without starting an Agent Run.
        const nativeWindow = await harness.application.browserWindow(page);
        await nativeWindow.evaluate((window, payload) => {
          window.webContents.send("readback:event", payload);
        }, event);
        const card = page.getByTestId("readback-stack").locator("[data-readback]");
        await expect(card).toBeVisible();
        await expectAboveWebContent(card, "the Readback card");

        await page.getByRole("button", { name: "Enter full view", exact: true }).click();
        await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
        await page
          .getByRole("navigation", { name: "App navigation", exact: true })
          .getByRole("button", { name: "Home", exact: true })
          .hover();
        await expect(page.getByTestId("app-shell-floating-left-panel")).toBeVisible();
        await expectAboveWebContent(
          page.getByTestId("app-shell-floating-left-panel"),
          "the floating sidebar",
        );
      },
    );
  } finally {
    await site.close();
  }
});
