import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  browserGuestId,
  browserPageHtml,
  browserTab,
  openBrowserPage,
  startBrowserSite,
  visibleBrowserGuest,
} from "./support/browser-page";

const title = "Pointer drag fixture";
const route = "/pointer-drag";
const traceGuestInput = `<script>
window.dragEvents = [];
for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
  window.addEventListener(type, (event) => {
    window.dragEvents.push([event.type, event.buttons, event.clientX]);
  }, true);
}
</script>`;

test("Browser guest release ends a panel resize", async ({}, testInfo) => {
  const site = await startBrowserSite({ [route]: browserPageHtml(title, traceGuestInput) });
  try {
    await withElectronScenario(
      { label: "pointer-drag-release", scenarioId: null, prepareAgentRuntime: false },
      async ({ harness, page }) => {
        const nativeWindow = await harness.application.browserWindow(page);
        await nativeWindow.evaluate((window) => window.setContentSize(1280, 800));
        await page.emulateMedia({ reducedMotion: "reduce" });
        await openBrowserPage(page, `${site.origin}${route}`);
        await expect(browserTab(page, title)).toBeVisible();

        const guest = visibleBrowserGuest(page);
        const handle = page.getByRole("separator", { name: "Resize right panel", exact: true });
        await expect(guest).toBeVisible();
        const readDivider = () =>
          handle.evaluate(async (element) => {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
            const rect = element.getBoundingClientRect();
            return rect.left + rect.width / 2;
          });
        const startDividerX = await readDivider();
        // Press from the main-content side of the handle.
        const startX = Math.floor(startDividerX - 5);
        const bounds = await guest.boundingBox();
        if (!bounds) throw new Error("Browser page has no bounds");
        const y = Math.round(bounds.y + bounds.height / 2);
        const releaseX = Math.round(startDividerX + 180);
        expect(releaseX).toBeGreaterThan(bounds.x);
        expect(releaseX).toBeLessThan(bounds.x + bounds.width);

        const embedderTrace = await page.evaluateHandle(() => {
          const events: Array<[string, number, number]> = [];
          const record = ({ type, buttons, clientX }: PointerEvent) => {
            events.push([type, buttons, clientX]);
          };
          window.addEventListener("pointerdown", record, true);
          window.addEventListener("pointermove", record, true);
          window.addEventListener("pointerup", record, true);
          window.addEventListener("pointercancel", record, true);
          return events;
        });
        const guestId = await browserGuestId(guest);
        const readGuestTrace = () =>
          harness.application.evaluate(
            async ({ webContents }, id) =>
              await webContents.fromId(id)?.executeJavaScript("window.dragEvents"),
            guestId,
          );

        await expect
          .poll(async () => {
            // The guest must be hit-testable before starting the drag.
            await page.mouse.move(releaseX - 1, y);
            await page.mouse.move(releaseX, y);
            return (await readGuestTrace())?.length ?? 0;
          })
          .toBeGreaterThan(0);
        await page.mouse.move(startX, y);
        await page.mouse.down();
        let afterShortMove: number;
        let beforeRelease: number;
        try {
          await page.mouse.move(startX + 12, y, { steps: 3 });
          afterShortMove = await readDivider();
          // Cross into the guest in a single sample, ahead of the moving divider.
          await page.mouse.move(releaseX, y);
          beforeRelease = await readDivider();
        } finally {
          await page.mouse.up();
        }

        const afterRelease = await readDivider();
        await page.mouse.move(startX - 100, y, { steps: 6 });
        const afterReturn = await readDivider();
        await testInfo.attach("pointer-routing", {
          contentType: "application/json",
          body: JSON.stringify({
            startDividerX,
            startX,
            releaseX,
            afterShortMove,
            beforeRelease,
            afterRelease,
            afterReturn,
            embedder: await embedderTrace.jsonValue(),
            guest: await readGuestTrace(),
          }),
        });
        expect(
          Math.abs(afterReturn - afterRelease),
          "The divider stays where it was released",
        ).toBeLessThanOrEqual(2);
        expect(
          Math.abs(afterRelease - beforeRelease),
          "The release keeps the width reached by the drag",
        ).toBeLessThanOrEqual(2);
        expect(afterReturn, "The Browser panel was narrowed").toBeGreaterThan(startDividerX + 2);
      },
    );
  } finally {
    await site.close();
  }
});
