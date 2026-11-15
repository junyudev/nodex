import http from "node:http";
import { expect, type Locator, type Page } from "@playwright/test";
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

/**
 * Clicks a page element with real pointer input, so anything covering the page would fail it.
 *
 * Do not call `page.setViewportSize` in a spec that uses this: Playwright then emulates that
 * viewport inside the Browser page too, some time after it loads, and the page no longer lays
 * out at the size it is shown.
 */
export async function clickInBrowserPage(
  harness: ElectronScenarioHarness,
  page: Page,
  guest: Locator,
  elementId: string,
  modifiers: Array<"Meta" | "Control" | "Shift"> = [],
) {
  const guestId = await browserGuestId(guest);
  const measure = async () => {
    const bounds = await guest.boundingBox();
    if (!bounds) throw new Error("Browser page has no bounds");
    const target = await harness.application.evaluate(
      async ({ webContents }, input) => {
        const contents = webContents.fromId(input.guestId);
        if (!contents) throw new Error("Missing Browser page");
        return (await contents.executeJavaScript(
          `(() => {
            const rect = document.getElementById(${JSON.stringify(input.elementId)}).getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, viewportWidth: innerWidth };
          })()`,
        )) as { x: number; y: number; viewportWidth: number };
      },
      { guestId, elementId },
    );
    return { bounds, target };
  };
  // A page shown again after sitting in the background is still growing back to its panel.
  await expect
    .poll(async () => {
      const { bounds, target } = await measure();
      return Math.abs(target.viewportWidth - bounds.width) <= 1;
    })
    .toBe(true);
  const { bounds, target } = await measure();
  const point = { x: bounds.x + target.x, y: bounds.y + target.y };
  // The pointer reaches the element only once the page is laid out at its shown size, its
  // surface is the one hit-tested, and nothing in the app (a passing toast, say) lies over it.
  await settlePointerOn(page, point, async () =>
    harness.application.evaluate(
      async ({ webContents }, input) =>
        (await webContents
          .fromId(input.guestId)
          ?.executeJavaScript(
            `document.getElementById(${JSON.stringify(input.elementId)}).matches(":hover")`,
          )) === true,
      { guestId, elementId },
    ),
  );
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  try {
    await page.mouse.click(point.x, point.y);
  } finally {
    for (const modifier of modifiers) await page.keyboard.up(modifier);
  }
}

/**
 * Clicks app UI drawn over a Browser page, once the pointer is routed to it rather than to the
 * page beneath.
 */
export async function clickAboveBrowserPage(page: Page, target: Locator) {
  const bounds = await target.boundingBox();
  if (!bounds) throw new Error("The element over the Browser page has no bounds");
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await settlePointerOn(page, point, async () =>
    target.evaluate((element) => element.matches(":hover")),
  );
  await page.mouse.click(point.x, point.y);
}

/**
 * Moves the pointer to `point` and waits until it stays on the element there. Where a page and
 * app UI overlap, which of them receives the pointer takes a few frames to follow what is
 * drawn, and can waver on the way: one hover proves nothing about the click after it, and a
 * click sent early goes to the wrong side. A person is never quick enough to hit that window.
 */
async function settlePointerOn(
  page: Page,
  point: { x: number; y: number },
  isHovered: () => Promise<boolean>,
) {
  let streak = 0;
  await expect
    .poll(
      async () => {
        await page.mouse.move(point.x + 1, point.y + 1);
        await page.mouse.move(point.x, point.y);
        streak = (await isHovered()) ? streak + 1 : 0;
        return streak;
      },
      { intervals: [100] },
    )
    .toBeGreaterThanOrEqual(3);
}

export const browserTab = (page: Page, name: string) =>
  page.getByRole("tab", { name, exact: true });
