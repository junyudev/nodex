import { expect, test, type Locator } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { DEFAULT_CODEX_HOST_ID } from "../../src/shared/codex-host";
import type { IpcEvents } from "../../src/shared/ipc-api";
import { readbackId } from "../../src/shared/readback";
import { startBrowserHttpFixture } from "./support/browser-http-fixture";
import {
  browserGuestId,
  browserPageHtml,
  clickInBrowserPage,
  openBrowserPage,
  startBrowserSite,
  visibleBrowserGuest,
} from "./support/browser-page";
import { readWindowBinding } from "./support/window-binding";

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
        const address = page.getByRole("combobox", { name: "Search pages or enter a URL" });
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

        const { spaceId } = (await readWindowBinding(page)).space;
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

test("Browser page shortcuts respect page handlers and annotation keys stay with their surface @automatic", async () => {
  const title = "Browser keyboard fixture";
  const site = await startBrowserSite({
    "/": browserPageHtml(
      title,
      `
      <input id="editor" value="Guest text">
      <button id="guest-target">Page control</button>
      <script>
        window.addEventListener("keydown", (event) => {
          if (!event.metaKey && !event.ctrlKey) return;
          document.body.dataset.lastKey = event.key.toLowerCase();
          if (["f", "k", "l"].includes(document.body.dataset.lastKey)) event.preventDefault();
        });
      </script>
    `,
    ),
  });
  try {
    await withElectronScenario(
      { label: "browser-keyboard-routing", scenarioId: null, prepareAgentRuntime: false },
      async ({ harness, page }) => {
        await openBrowserPage(page, site.origin);
        const guest = visibleBrowserGuest(page);
        await expect(guest).toBeVisible();
        const tab = page.getByRole("tab", { name: title, exact: true });
        await expect(tab).toBeVisible();
        const tabId = await page
          .locator("[data-browser-sidebar-panel-tab]")
          .getAttribute("data-browser-sidebar-panel-tab");
        expect(tabId).toBeTruthy();
        const guestId = await browserGuestId(guest);
        const guestState = (expression: string) =>
          harness.application.evaluate(
            ({ webContents }, { guestId, expression }) =>
              webContents.fromId(guestId)?.executeJavaScript(expression),
            { guestId, expression },
          );
        const pressGuest = (
          keyCode: string,
          {
            primary = true,
            shift = false,
            phase = "press",
          }: {
            primary?: boolean;
            shift?: boolean;
            phase?: "down" | "up" | "press";
          } = {},
        ) =>
          harness.application.evaluate(
            ({ webContents }, { guestId, keyCode, primary, shift, phase }) => {
              const contents = webContents.fromId(guestId);
              if (!contents) throw new Error("Missing Browser page");
              const modifiers: NonNullable<Electron.InputEvent["modifiers"]> = [];
              if (primary) modifiers.push(process.platform === "darwin" ? "meta" : "control");
              if (shift) modifiers.push("shift");
              if (phase !== "up") contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
              if (phase !== "down") contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
            },
            { guestId, keyCode, primary, shift, phase },
          );
        await page.evaluate(() => {
          const invocations: unknown[] = [];
          window.api?.onWorkbenchCommand?.((invocation) => {
            invocations.push(invocation);
            document.body.dataset.browserKeyboardInvocations = JSON.stringify(invocations);
          });
        });
        const readInvocations = () =>
          page.evaluate(() => JSON.parse(document.body.dataset.browserKeyboardInvocations ?? "[]"));
        await clickInBrowserPage(harness, page, guest, "editor");
        await expect.poll(() => guestState("document.activeElement.id")).toBe("editor");
        await guestState("document.activeElement.setSelectionRange(10, 10)");
        await pressGuest("Backspace", { primary: false });
        await expect.poll(() => guestState("document.activeElement.value")).toBe("Guest tex");

        await pressGuest("K");
        await expect.poll(() => guestState("document.body.dataset.lastKey")).toBe("k");
        await pressGuest("F");
        await expect.poll(() => guestState("document.body.dataset.lastKey")).toBe("f");
        await pressGuest("G");
        await expect
          .poll(readInvocations)
          .toEqual([
            expect.objectContaining({ commandId: "findNext", source: "keyboard_shortcut" }),
          ]);
        await expect(page.getByPlaceholder("Find in page")).toBeHidden();
        // A page that calls preventDefault on the address chord still yields to the Browser.
        await pressGuest("L");
        await expect.poll(readInvocations).toEqual([
          expect.objectContaining({ commandId: "findNext" }),
          expect.objectContaining({
            commandId: "focusBrowserAddressBar",
            source: "keyboard_shortcut",
            browserTab: expect.objectContaining({ browserTabId: tabId }),
          }),
        ]);
        // The Workbench acts on it: this Browser's address field takes the keyboard.
        await expect(
          page.locator("[data-browser-sidebar-address-input='true']:visible"),
        ).toBeFocused();
        expect(await guestState("document.body.dataset.lastKey")).toBe("g");

        const rebind = await page.evaluate(() =>
          window.api?.invoke("set-codex-command-keybinding", "focusBrowserAddressBar", {
            type: "set",
            keybinding: { key: "CmdOrCtrl+Shift+L" },
          }),
        );
        expect(rebind).toMatchObject({ type: "applied" });
        await clickInBrowserPage(harness, page, guest, "editor");
        await pressGuest("L");
        await expect.poll(() => guestState("document.body.dataset.lastKey")).toBe("l");
        await pressGuest("L", { shift: true });
        await expect
          .poll(readInvocations)
          .toEqual([
            expect.objectContaining({ commandId: "findNext" }),
            expect.objectContaining({ commandId: "focusBrowserAddressBar" }),
            expect.objectContaining({ commandId: "focusBrowserAddressBar" }),
          ]);

        const annotate = page.getByRole("button", { name: "Annotate", exact: true });
        const commentMode = page.getByRole("button", { name: "Exit comment mode", exact: true });
        await annotate.click();
        const region = page.getByRole("button", { name: "Region", exact: true });
        await expect(region).toBeVisible();
        await guest.focus();
        await guestState("document.getElementById('guest-target').focus()");
        await expect.poll(() => guestState("document.activeElement.id")).toBe("guest-target");
        await pressGuest("Space", { primary: false, phase: "down" });
        try {
          await expect(region).toBeHidden();
        } finally {
          await pressGuest("Space", { primary: false, phase: "up" });
        }
        await expect(region).toBeVisible();
        await region.press("Escape");
        await expect(commentMode).toBeHidden();

        await annotate.click();
        await expect(commentMode).toBeVisible();
        await page.keyboard.press("ControlOrMeta+k");
        const palette = page.getByRole("combobox", { name: "Command palette search" });
        await expect(palette).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(palette).toBeHidden();
        await expect(commentMode).toBeVisible();

        await commentMode.focus();
        await page.keyboard.press("ControlOrMeta+f");
        const findInput = page.getByPlaceholder("Find in page");
        await expect(findInput).toBeVisible();
        await findInput.focus();
        await expect(findInput).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(findInput).toBeHidden();
        await expect(commentMode).toBeVisible();

        const sidebarToggle = page.getByRole("button", { name: "Hide sidebar", exact: true });
        await sidebarToggle.focus();
        await page.keyboard.press("Space");
        await expect(page.getByRole("button", { name: "Show sidebar", exact: true })).toBeVisible();
        await expect(commentMode).toBeVisible();
      },
    );
  } finally {
    await site.close();
  }
});
