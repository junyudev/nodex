import { expect, test, type Locator } from "@playwright/test";
import {
  withElectronScenario,
  type ElectronScenarioContext,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  browserGuestId,
  browserPageHtml,
  browserTab,
  openBrowserPage,
  startBrowserSite,
  visibleBrowserGuest,
} from "./support/browser-page";

const title = "Browser drag target";
const route = "/drag-target";
const guestInputTrace = `<script>
window.pointerEvents = [];
for (const type of ["pointermove", "pointerup"]) {
  window.addEventListener(type, (event) => {
    window.pointerEvents.push([event.type, event.buttons]);
  });
}
</script>`;

type GuestEvent = [type: string, buttons: number];

function withBrowserDragFixture(
  label: string,
  run: (context: ElectronScenarioContext, url: string) => Promise<void>,
) {
  return withElectronScenario(
    { label, scenarioId: null, prepareAgentRuntime: false },
    async (context) => {
      const { application, page } = context;
      const nativeWindow = await application.browserWindow(page);
      await nativeWindow.evaluate((window) => window.setContentSize(1280, 800));
      await page.emulateMedia({ reducedMotion: "reduce" });
      const site = await startBrowserSite({ [route]: browserPageHtml(title, guestInputTrace) });
      try {
        await run(context, `${site.origin}${route}`);
      } finally {
        await site.close();
      }
    },
  );
}

async function openDragGuest({ application, page }: ElectronScenarioContext, url: string) {
  await openBrowserPage(page, url);
  await expect(browserTab(page, title)).toBeVisible();
  const guest = visibleBrowserGuest(page);
  await expect(guest).toBeVisible();
  const guestId = await browserGuestId(guest);
  const readGuestTrace = () =>
    application.evaluate(
      async ({ webContents }, id) =>
        ((await webContents.fromId(id)?.executeJavaScript("window.pointerEvents")) ??
          []) as GuestEvent[],
      guestId,
    );
  const measureReleasePoint = async () => {
    const point = await pointIn(guest);
    const previousEvents = (await readGuestTrace()).length;
    await expect
      .poll(async () => {
        // Prove the Browser page receives input at the planned release point.
        await page.mouse.move(point.x - 1, point.y);
        await page.mouse.move(point.x, point.y);
        return (await readGuestTrace())
          .slice(previousEvents)
          .some(([type, buttons]) => type === "pointermove" && buttons === 0);
      })
      .toBe(true);
    return point;
  };

  return { measureReleasePoint, readGuestTrace };
}

async function pointIn(locator: Locator, yRatio = 0.5) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Drag target has no bounds");
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height * yRatio) };
}

test("releasing a sidebar chat over a Browser page ends the reorder without moving the chat", async ({}, testInfo) => {
  await withBrowserDragFixture("sidebar-drag-browser-release", async (context, url) => {
    const { page, seed } = context;
    const { sectionId } = await seed.createSidebarSection({ name: "Drag fixtures" });
    const titles = ["First chat", "Second chat", "Third chat"];
    for (const title of titles.toReversed()) {
      await seed.createSessionInSidebarSection({ sectionId, title });
    }
    const { measureReleasePoint, readGuestTrace } = await openDragGuest(context, url);
    const releasePoint = await measureReleasePoint();

    const lane = page.locator('[data-app-action-sidebar-section-heading="Drag fixtures"]:visible');
    const toggle = lane.locator("[data-app-action-sidebar-section-toggle]");
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    const rows = lane.locator("[data-app-action-sidebar-thread-row]");
    const readOrder = () =>
      rows.evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-app-action-sidebar-thread-title")),
      );
    await expect.poll(readOrder).toEqual(titles);
    const start = await pointIn(rows.first());
    const returnPoint = await pointIn(rows.last(), 0.25);
    const overlay = page.locator("body > div:not(#root) > [inert][aria-hidden]").filter({
      has: page.getByText(titles[0], { exact: true }),
    });
    const indicator = lane.locator('[role="presentation"][aria-hidden="true"]');
    const pressed = lane.locator('[aria-roledescription="sortable"][aria-pressed="true"]');

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    try {
      await page.mouse.move(start.x, start.y + 10, { steps: 3 });
      await expect(pressed).toHaveCount(1);
      await expect(overlay).toBeVisible();
      await page.mouse.move(returnPoint.x, returnPoint.y, { steps: 6 });
      await page.mouse.move(returnPoint.x, returnPoint.y + 1);
      await expect(indicator).toHaveCount(1);
      await page.mouse.move(releasePoint.x, releasePoint.y, { steps: 20 });
    } finally {
      await page.mouse.up();
    }

    await page.mouse.move(returnPoint.x, returnPoint.y, { steps: 12 });
    await page.mouse.move(returnPoint.x, returnPoint.y + 1);
    await testInfo.attach("guest-pointer-routing", {
      contentType: "application/json",
      body: JSON.stringify(await readGuestTrace()),
    });
    await expect(
      overlay,
      "The reorder preview disappears after release over the Browser page",
    ).toHaveCount(0);
    await expect(pressed).toHaveCount(0);
    await expect(indicator).toHaveCount(0);
    expect(await readOrder()).toEqual(titles);
  });
});

test("releasing a terminal selection over a Browser page keeps it fixed on hover", async ({}) => {
  await withBrowserDragFixture("terminal-drag-browser-release", async (context, url) => {
    const { page } = context;
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    const { measureReleasePoint } = await openDragGuest(context, url);
    await page.getByRole("button", { name: "Toggle bottom panel", exact: true }).click();
    const terminal = page.locator('[data-codex-terminal="true"]');
    const screen = terminal.locator(".xterm-screen");
    await screen.click({ position: { x: 32, y: 9 } });
    await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
    await page.keyboard.insertText("echo A terminal line for selecting with the pointer");
    await page.keyboard.press("Enter");

    const releasePoint = await measureReleasePoint();
    const output = terminal.locator(".xterm-rows > div").filter({
      hasText: /^A terminal line for selecting with the pointer$/,
    });
    await expect(output).toBeVisible();
    const line = await output.boundingBox();
    if (!line) throw new Error("Terminal output has no bounds");
    const y = Math.round(line.y + line.height / 2);
    const startX = Math.round(line.x + 16);
    const returnX = startX + 48;
    const readSelection = () =>
      terminal.locator(".xterm-selection").evaluate(async (layer) => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return Array.from(layer.children, (rectangle) =>
          rectangle.getBoundingClientRect().toJSON(),
        );
      });

    await page.mouse.move(startX, y);
    await page.mouse.down();
    try {
      await page.mouse.move(startX + 140, y, { steps: 8 });
      expect(await readSelection()).not.toHaveLength(0);
      await page.mouse.move(releasePoint.x, releasePoint.y, { steps: 20 });
    } finally {
      await page.mouse.up();
    }

    const releasedSelection = await readSelection();
    expect(releasedSelection).not.toHaveLength(0);
    await page.mouse.move(returnX, y, { steps: 12 });
    await page.mouse.move(returnX + 1, y);
    expect(await readSelection(), "Hover leaves the released terminal selection unchanged").toEqual(
      releasedSelection,
    );
  });
});
