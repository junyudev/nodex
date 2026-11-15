import http from "node:http";
import type { Locator, Page } from "@playwright/test";
import type { ElectronScenarioHarness } from "../../../scripts/scenarios/harness/electron-e2e-harness";

export const browserPageHtml = (title: string, body = title) =>
  `<!doctype html><html><head><title>${title}</title></head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;

/** A loopback site serving the given documents by path. */
export async function startBrowserSite(pages: Readonly<Record<string, string>>) {
  const server = http.createServer((request, response) => {
    const body = pages[new URL(request.url ?? "/", "http://127.0.0.1").pathname];
    response.writeHead(body ? 200 : 404, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(body ?? browserPageHtml("Not found"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser site returned no port");
  return {
    host: `127.0.0.1:${address.port}`,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Opens a New tab in the Browser and loads the address in it. */
export async function openBrowserPage(page: Page, url: string) {
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  const address = page.getByRole("combobox", { name: "Search or enter a URL" });
  await address.fill(url);
  await address.press("Enter");
}

export const visibleBrowserGuest = (page: Page) =>
  page.locator(
    '[data-browser-sidebar-webview-manager-root][data-browser-sidebar-webview-host-kind="panel"]:visible webview',
  );

export const browserGuestId = async (guest: Locator) =>
  await guest.evaluate((element) =>
    (element as unknown as { getWebContentsId(): number }).getWebContentsId(),
  );

/** Clicks a page element with real pointer input, so anything covering the page would fail it. */
export async function clickInBrowserPage(
  harness: ElectronScenarioHarness,
  page: Page,
  guest: Locator,
  elementId: string,
  modifiers: Array<"Meta" | "Control" | "Shift"> = [],
) {
  const guestId = await browserGuestId(guest);
  const target = await harness.application.evaluate(
    async ({ webContents }, input) => {
      const contents = webContents.fromId(input.guestId);
      if (!contents) throw new Error("Missing Browser page");
      return (await contents.executeJavaScript(
        `(() => {
          const rect = document.getElementById(${JSON.stringify(input.elementId)}).getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`,
      )) as { x: number; y: number };
    },
    { guestId, elementId },
  );
  const bounds = await guest.boundingBox();
  if (!bounds) throw new Error("Browser page has no bounds");
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  try {
    await page.mouse.click(bounds.x + target.x, bounds.y + target.y);
  } finally {
    for (const modifier of modifiers) await page.keyboard.up(modifier);
  }
}

export const browserTab = (page: Page, name: string) =>
  page.getByRole("tab", { name, exact: true });
