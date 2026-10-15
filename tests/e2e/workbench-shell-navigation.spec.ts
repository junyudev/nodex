import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  PAGE_RELOCATION_SCENARIO_ID,
  requirePageRelocationScenarioFacts,
} from "../../scripts/scenarios/scenarios/page-relocation";
import {
  buildNativePointerProbe,
  clickThroughNativeWindow,
  readNativeDragRegions,
} from "./support/native-window-input";

interface EvidenceClaim {
  name: string;
  expected: unknown;
  actual: unknown;
}

const PAGE_TITLE = "Sidebar Page to move";
const DATABASE_TITLE = "Relocation Alpha DB";
const rail = (page: Page) => page.getByRole("navigation", { name: "App navigation", exact: true });
const tabs = (page: Page) => page.locator('[data-app-shell-tab-controller] [role="tab"]:visible');
const content = (page: Page) =>
  page
    .getByRole("navigation", { name: "Space", exact: true })
    .getByRole("list", { name: "Content" });
const pageStage = (page: Page, pageId: string) =>
  page.locator(`[data-page-stage-page-id="${pageId}"]:visible`);

const readTabLabels = async (page: Page) =>
  tabs(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label")),
  );

const readTabIdentities = async (page: Page) =>
  tabs(page).evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.closest("[data-app-shell-tab-controller]")?.getAttribute("data-tab-id"),
      title: element.getAttribute("aria-label"),
    })),
  );

const readNativeSafeGeometry = async (page: Page) =>
  page.evaluate(() => {
    const header = document.querySelector('[data-testid="workbench-global-header"]');
    const pane = document.querySelector("[data-workbench-main-surface]");
    if (!header || !pane) throw new Error("Missing native-safe Workbench surface");
    const safeInset = Number.parseFloat(
      getComputedStyle(header).getPropertyValue("--spacing-token-safe-header-left"),
    );
    const controls = Array.from(header.querySelectorAll('button, [role="tab"]'))
      .filter((element) => getComputedStyle(element).visibility === "visible")
      .map((element) => element.getBoundingClientRect())
      .filter((bounds) => bounds.width > 0 && bounds.height > 0);
    const firstControlLeft = Math.min(...controls.map((bounds) => bounds.left));
    const firstTabLeft = Array.from(header.querySelectorAll('[role="tab"]'))
      .filter((element) => getComputedStyle(element).visibility === "visible")
      .map((element) => element.getBoundingClientRect())
      .find((bounds) => bounds.width > 0)?.left;
    return {
      safeInset,
      firstControlLeft,
      firstTabLeft,
      controlsClearNativeSafeInset: firstControlLeft >= safeInset,
      tabsClearNativeSafeInset: firstTabLeft !== undefined && firstTabLeft >= safeInset,
      surfaceTop: pane.getBoundingClientRect().top,
    };
  });

const readGeometry = async (page: Page) =>
  page.evaluate(() => {
    const navigation = document.querySelector("[data-app-navigation-rail]");
    const header = document.querySelector('[data-testid="workbench-global-header"]');
    const pill = Array.from(document.querySelectorAll("[data-app-shell-tab-surface]")).find(
      (element) => element.getBoundingClientRect().width > 0,
    );
    const pane = document.querySelector("[data-workbench-main-surface]");
    const tabHitTarget = pill?.querySelector('[role="tab"]');
    if (!navigation || !header || !pill || !pane || !tabHitTarget)
      throw new Error("Missing Workbench geometry surface");
    const railBounds = navigation.getBoundingClientRect();
    const paneBounds = pane.getBoundingClientRect();
    const railButtons = Array.from(navigation.querySelectorAll("button"));
    return {
      rail: { width: railBounds.width, top: railBounds.top },
      // The account control appears above Settings only once the account state is known.
      buttons: railButtons
        .filter((button) => !button.closest("[data-workbench-rail-account]"))
        .map((button) => {
          const bounds = button.getBoundingClientRect();
          return {
            label: button.getAttribute("aria-label"),
            width: bounds.width,
            height: bounds.height,
          };
        }),
      railFootBottomInset:
        window.innerHeight - (railButtons.at(-1)?.getBoundingClientRect().bottom ?? 0),
      headerHeight: header.getBoundingClientRect().height,
      surfaceTop: paneBounds.top,
      tabHeaderTop: pill.closest("[data-workbench-pane-titlebar]")?.getBoundingClientRect().top,
      tabHeaderInGlobalChrome: header.contains(pill),
      contentOwnsGlobalChrome: pane.contains(header) || pane.contains(navigation),
      tabPillHeight: pill.getBoundingClientRect().height,
      tabHitHeight: tabHitTarget.getBoundingClientRect().height,
      paneInsets: {
        right: window.innerWidth - paneBounds.right,
        bottom: window.innerHeight - paneBounds.bottom,
      },
    };
  });

const readPaint = async (page: Page) =>
  page.evaluate(() => {
    const navigation = document.querySelector("[data-app-navigation-rail]");
    const shell = document.querySelector("[data-workbench-shell]");
    const header = document.querySelector('[data-testid="workbench-global-header"]');
    const main = document.querySelector("[data-app-shell-main-surface]");
    if (!navigation || !shell || !header || !main)
      throw new Error("Missing Workbench paint surface");
    const background = getComputedStyle(main).backgroundColor;
    const sidebarRole = getComputedStyle(shell)
      .getPropertyValue("--color-token-side-bar-background")
      .trim();
    const alphaOf = (color: string) =>
      Number.parseFloat(
        color.startsWith("rgba(")
          ? color.slice(color.lastIndexOf(",") + 1, -1).trim()
          : (color.split("/")[1]?.replace(")", "").trim() ?? "1"),
      );
    const alpha = alphaOf(background);
    return {
      windowType: document.documentElement.getAttribute("data-codex-window-type"),
      electronOpaque: document.documentElement.classList.contains("electron-opaque"),
      shellBackgroundAlpha: alphaOf(getComputedStyle(shell).backgroundColor),
      railBackground: getComputedStyle(navigation).backgroundColor,
      headerBackground: getComputedStyle(header).backgroundColor,
      sidebarRole,
      sidebarRoleDefined: sidebarRole.length > 0,
      mainBackground: background,
      mainOpaque: alpha === 1,
      dark: document.documentElement.classList.contains("dark"),
    };
  });

const readSidebarHeader = async (page: Page) =>
  page.evaluate(() => {
    const header = document.querySelector("[data-app-action-sidebar-scroll-header]");
    const title = header?.querySelector("[data-workbench-sidebar-title-row] h2");
    const search = header?.querySelector(
      '[data-workbench-sidebar-title-row] button[aria-label="Search"]',
    );
    const firstRow = header?.querySelector(":scope > div:last-child button");
    if (!title || !search || !firstRow) throw new Error("Missing contextual sidebar header");
    const box = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    };
    const titleStyle = getComputedStyle(title);
    return {
      title: {
        x: box(title).x,
        y: box(title).y,
        font: `${titleStyle.fontSize}/${titleStyle.lineHeight}`,
      },
      search: box(search),
      firstRow: box(firstRow),
    };
  });

const readOverflow = async (page: Page) =>
  page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("[data-workbench-shell]");
    if (!shell) throw new Error("Missing Workbench shell");
    return {
      shell: Math.max(0, shell.scrollWidth - shell.clientWidth),
      document: Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    };
  });

const selectAppearance = async (page: Page, mode: "Light" | "Dark") => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Appearance", exact: true }).click();
  const choice = page.getByRole("radio", { name: mode, exact: true });
  await choice.locator("..").click();
  await expect(choice).toBeChecked();
  if (mode === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
  const checked = await choice.isChecked();
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to app", exact: true })).toHaveCount(0);
  return checked;
};

test("keeps Home and Space navigation, tabs and chrome across Settings and restart", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const artifacts =
    process.env.NODEX_WORKBENCH_SHELL_ARTIFACT_DIR ?? testInfo.outputPath("workbench-shell-review");
  await mkdir(artifacts, { recursive: true });
  const claims: EvidenceClaim[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  let status: "passed" | "failed" = "failed";
  let failure: string | null = null;
  try {
    await withElectronScenario(
      {
        label: "workbench-shell-navigation",
        scenarioId: PAGE_RELOCATION_SCENARIO_ID,
        onFailure: async ({ readRuntimeLogs }) => {
          await writeFile(path.join(artifacts, "runtime.log"), await readRuntimeLogs());
        },
      },
      async ({ page: initialPage, harness, facts, seed }) => {
        const relocation = requirePageRelocationScenarioFacts(facts);
        const rendererErrors: string[] = [];
        let page = initialPage;
        let recording: Page | undefined;
        page.on("pageerror", (error) => rendererErrors.push(error.message));
        const capture = async (name: string) => {
          // Assertions own settling; retain a readable native frame for each verified state.
          await page.waitForTimeout(750);
          await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
        };
        const expectHomeProject = async () => {
          await expect(
            rail(page).getByRole("button", { name: "Home", exact: true }),
          ).toHaveAttribute("aria-current", "page");
          await expect(
            page.getByRole("tab", { name: "Project Home", exact: true }),
          ).toHaveAttribute("aria-selected", "true");
          await expect(page.getByRole("tab", { name: "Project Home", exact: true })).toBeVisible();
          await expect(
            page.locator(`[data-board-uuid-v7="${relocation.sourcePageId}"]:visible`),
          ).toBeVisible();
        };
        const expectSpacePage = async () => {
          await expect(
            rail(page).getByRole("button", { name: "Space", exact: true }),
          ).toHaveAttribute("aria-current", "page");
          await expect(page.getByRole("tab", { name: PAGE_TITLE, exact: true })).toHaveAttribute(
            "aria-selected",
            "true",
          );
          await expect(pageStage(page, relocation.standalonePageId)).toBeVisible();
        };
        try {
          await page.setViewportSize({ width: 1280, height: 800 });
          await rail(page).getByRole("button", { name: "Home", exact: true }).click();
          await page
            .getByRole("navigation", { name: "Home", exact: true })
            .getByRole("button", { name: "Open Relocation Alpha", exact: true })
            .click();
          await expectHomeProject();

          const shellSession = await seed.createRelatedChat({
            projectId: relocation.sourceProjectId,
            initialPageIds: [],
            noThreadFallbackTitle: "Shell tabs fixture",
          });

          await selectAppearance(page, "Light");
          await expectHomeProject();
          const lightPaint = await readPaint(page);
          claim(
            "Light chrome tints native material once and keeps content opaque",
            {
              windowType: "electron",
              electronOpaque: false,
              shellBackgroundAlpha: 0.85,
              railBackground: "rgba(0, 0, 0, 0)",
              headerBackground: "rgba(0, 0, 0, 0)",
              sidebarRole: lightPaint.sidebarRole,
              sidebarRoleDefined: true,
              mainBackground: lightPaint.mainBackground,
              mainOpaque: true,
              dark: false,
            },
            lightPaint,
          );
          await page.screenshot({ path: path.join(artifacts, "light-paint.png") });
          claim(
            "Dark Mode is selected through Appearance",
            true,
            await selectAppearance(page, "Dark"),
          );
          await expectHomeProject();
          const darkPaint = await readPaint(page);
          claim(
            "Dark chrome tints native material once with a distinct sidebar role",
            {
              windowType: "electron",
              electronOpaque: false,
              shellBackgroundAlpha: 0.8,
              railBackground: "rgba(0, 0, 0, 0)",
              headerBackground: "rgba(0, 0, 0, 0)",
              sidebarRole: darkPaint.sidebarRole,
              sidebarRoleDefined: true,
              mainBackground: darkPaint.mainBackground,
              mainOpaque: true,
              dark: true,
              distinctFromLight: true,
            },
            {
              ...darkPaint,
              distinctFromLight: darkPaint.sidebarRole !== lightPaint.sidebarRole,
            },
          );
          claim(
            "Workbench chrome has the exact rail, button, header and tab dimensions",
            {
              rail: { width: 52, top: 44 },
              buttons: [
                { label: "Home", width: 36, height: 36 },
                { label: "Space", width: 36, height: 36 },
                { label: "Settings", width: 36, height: 36 },
              ],
              railFootBottomInset: 8,
              headerHeight: 44,
              surfaceTop: 44,
              tabHeaderTop: 0,
              tabHeaderInGlobalChrome: true,
              contentOwnsGlobalChrome: false,
              tabPillHeight: 32,
              tabHitHeight: 32,
              paneInsets: { right: 4, bottom: 4 },
            },
            await readGeometry(page),
          );
          const nativeWindow = await harness.application.browserWindow(page);
          const nativeChrome = await nativeWindow.evaluate((window) => ({
            buttons: window.getWindowButtonPosition(),
            zoom: window.webContents.getZoomFactor(),
          }));
          if (process.platform === "darwin") {
            claim(
              "Native traffic lights are vertically centered in the shared titlebar",
              { buttons: { x: 16, y: 15 }, zoom: 1 },
              nativeChrome,
            );
          }

          claim(
            "Window navigation follows the titlebar order and native safe inset",
            [
              { label: "Back", left: 88, width: 28, height: 28 },
              { label: "Forward", left: 122, width: 28, height: 28 },
              { label: "Hide sidebar", left: 156, width: 28, height: 28 },
            ],
            await page.getByTestId("workbench-window-navigation-chrome").evaluateAll((groups) => {
              const group = groups.find(
                (element) =>
                  getComputedStyle(element).visibility === "visible" &&
                  element.getBoundingClientRect().width > 0,
              );
              if (!group) throw new Error("Missing visible window navigation controls");
              return Array.from(group.querySelectorAll("button")).map((button) => {
                const bounds = button.getBoundingClientRect();
                return {
                  label: button.getAttribute("aria-label"),
                  left: bounds.left,
                  width: bounds.width,
                  height: bounds.height,
                };
              });
            }),
          );
          const homeHeader = await readSidebarHeader(page);
          claim(
            "Project titlebar keeps every control clickable and empty chrome draggable",
            { blockedControls: [], draggableAt: [true, true] },
            await readNativeDragRegions(page, [
              { x: 300, y: 22 },
              { x: 720, y: 22 },
            ]),
          );
          if (process.platform === "darwin") {
            const probe = buildNativePointerProbe();
            const bottomToggle = page.getByRole("button", {
              name: "Toggle bottom panel",
              exact: true,
            });
            const toggleBox = await bottomToggle.boundingBox();
            if (!toggleBox) throw new Error("Missing bottom panel toggle");
            const toggleCenter = {
              x: toggleBox.x + toggleBox.width / 2,
              y: toggleBox.y + toggleBox.height / 2,
            };
            const nativeToggle = await clickThroughNativeWindow(
              nativeWindow,
              page,
              probe,
              toggleCenter,
            );
            await expect(bottomToggle).toHaveAttribute("aria-pressed", "true");
            const nativeEmptyTitlebar = await clickThroughNativeWindow(nativeWindow, page, probe, {
              x: 720,
              y: 22,
            });
            await nativeWindow.evaluate((window) => window.blur());
            await expect.poll(async () => (await readPaint(page)).electronOpaque).toBe(true);
            const firstClick = await clickThroughNativeWindow(
              nativeWindow,
              page,
              probe,
              toggleCenter,
            );
            await expect(bottomToggle).toHaveAttribute("aria-pressed", "false");
            claim(
              "AppKit clicks reach titlebar controls, empty titlebar drags, and an inactive window takes the first click",
              {
                toggle: { reachedRenderer: true, target: "Toggle bottom panel" },
                emptyTitlebar: { reachedRenderer: false, target: null },
                inactiveFirstClick: { reachedRenderer: true, target: "Toggle bottom panel" },
              },
              {
                toggle: nativeToggle,
                emptyTitlebar: nativeEmptyTitlebar,
                inactiveFirstClick: firstClick,
              },
            );
            await nativeWindow.evaluate((window) => window.focus());
          }
          await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
          await page.mouse.move(900, 700);
          await expect(
            page.getByRole("button", { name: "Show sidebar", exact: true }),
          ).toBeVisible();
          const peek = page.getByTestId("app-shell-floating-left-panel");
          await page.mouse.move(26, 70);
          await expect(peek).toBeVisible();
          // Cross the rail-to-surface gap slower than the close grace period.
          for (const x of [40, 44, 48, 52, 56, 64, 96, 160]) {
            await page.mouse.move(x, 74);
            await page.waitForTimeout(70);
          }
          await page.waitForTimeout(400);
          const peekBounds = await peek.boundingBox();
          claim(
            "A rail peek survives the gap into its surface and keeps the pinned geometry",
            { visible: true, x: 56, y: 48, width: 284 },
            {
              visible: await peek.isVisible(),
              x: peekBounds?.x,
              y: peekBounds?.y,
              width: peekBounds?.width,
            },
          );
          await page.mouse.move(900, 700);
          await expect(peek).toHaveCount(0);
          if (process.platform === "darwin") {
            const windowId = await nativeWindow.evaluate((window) => window.id);
            const zoomCommand = async (id: "view.zoomIn" | "view.resetZoom") => {
              await harness.application.evaluate(({ app, BrowserWindow }, ownedWindowId) => {
                const target = BrowserWindow.fromId(ownedWindowId);
                if (!target) throw new Error("The owned test window is unavailable");
                app.focus({ steal: true });
                target.focus();
                target.webContents.focus();
              }, windowId);
              await expect
                .poll(() =>
                  harness.application.evaluate(({ BrowserWindow, webContents }, ownedWindowId) => {
                    const target = BrowserWindow.fromId(ownedWindowId);
                    return (
                      target !== null &&
                      webContents.getFocusedWebContents()?.id === target.webContents.id
                    );
                  }, windowId),
                )
                .toBe(true);
              return harness.application.evaluate(
                ({ BrowserWindow, Menu, webContents }, input) => {
                  const target = BrowserWindow.fromId(input.windowId);
                  if (!target) throw new Error("The owned test window is unavailable");
                  const item = Menu.getApplicationMenu()?.getMenuItemById(input.id);
                  if (!item) throw new Error(`Missing application menu action ${input.id}`);
                  const before = target.webContents.getZoomFactor();
                  item.click({ triggeredByAccelerator: false }, target, target.webContents);
                  return {
                    command: input.id,
                    enabled: item.enabled,
                    targetWindowId: target.id,
                    targetContentsId: target.webContents.id,
                    windowFocused: target.isFocused(),
                    focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
                    focusedContentsId: webContents.getFocusedWebContents()?.id ?? null,
                    before,
                    after: target.webContents.getZoomFactor(),
                  };
                },
                { windowId, id },
              );
            };
            try {
              const zoomDispatch = await zoomCommand("view.zoomIn");
              await writeFile(
                path.join(artifacts, "native-zoom-dispatch.json"),
                `${JSON.stringify(zoomDispatch, null, 2)}\n`,
              );
              await expect
                .poll(() => nativeWindow.evaluate((window) => window.webContents.getZoomFactor()))
                .toBeGreaterThan(1);
              const zoomedNative = await nativeWindow.evaluate((window) => ({
                buttons: window.getWindowButtonPosition(),
                zoom: window.webContents.getZoomFactor(),
              }));
              await expect
                .poll(async () => {
                  const geometry = await readNativeSafeGeometry(page);
                  return Math.abs(geometry.safeInset - (82 / zoomedNative.zoom + 6)) < 0.01;
                })
                .toBe(true);
              const zoomedGeometry = await readNativeSafeGeometry(page);
              claim(
                "The actual Zoom In menu keeps native buttons and content clear of each other",
                {
                  nativeButtonY: Math.round((44 * zoomedNative.zoom - 14) / 2),
                  nativeReservationClear: true,
                  firstControlClear: true,
                  firstTabClear: true,
                },
                {
                  nativeButtonY: zoomedNative.buttons?.y,
                  nativeReservationClear: zoomedGeometry.safeInset * zoomedNative.zoom >= 82,
                  firstControlClear: zoomedGeometry.firstControlLeft * zoomedNative.zoom >= 82,
                  firstTabClear:
                    zoomedGeometry.firstTabLeft !== undefined &&
                    zoomedGeometry.firstTabLeft * zoomedNative.zoom >= 82,
                },
              );
              await writeFile(
                path.join(artifacts, "native-zoom-geometry.json"),
                `${JSON.stringify({ native: zoomedNative, geometry: zoomedGeometry }, null, 2)}\n`,
              );
            } finally {
              await zoomCommand("view.resetZoom");
              await expect
                .poll(() => nativeWindow.evaluate((window) => window.webContents.getZoomFactor()))
                .toBe(1);
              await expect
                .poll(async () => (await readNativeSafeGeometry(page)).safeInset)
                .toBe(88);
            }
          }
          await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
          await expectHomeProject();
          await nativeWindow.evaluate((window) => window.blur());
          const recordingOpaque = await expect
            .poll(async () => (await readPaint(page)).electronOpaque)
            .toBe(true)
            .then(
              () => true,
              () => false,
            );
          await writeFile(
            path.join(artifacts, "recording-surface.json"),
            `${JSON.stringify({ nativeWindowFocused: await nativeWindow.evaluate((window) => window.isFocused()), naturalOpaqueFallback: recordingOpaque, paint: await readPaint(page) }, null, 2)}\n`,
          );
          await page.screencast.start({
            path: path.join(artifacts, "review.webm"),
            size: { width: 1280, height: 800 },
            annotate: { position: "bottom", fontSize: 14 },
          });
          recording = page;
          await capture("home");

          const sessionRow = page
            .locator('[data-app-action-sidebar-thread-title="Shell tabs fixture"]:visible')
            .first();
          if (!(await sessionRow.isVisible())) {
            const projectRow = page.getByRole("listitem", {
              name: "Relocation Alpha",
              exact: true,
            });
            const expand = projectRow.getByRole("button", { name: "Expand project", exact: true });
            if (await expand.count()) {
              await projectRow.hover();
              await expand.click();
            }
          }
          await expect(sessionRow).toBeVisible();
          await sessionRow.click();
          await expect(page.locator('[data-codex-composer="true"]:visible')).toBeVisible();
          const showEmptyTabs = page.getByRole("button", { name: "New tab", exact: true });
          if (await showEmptyTabs.isVisible()) await showEmptyTabs.click();
          const emptyActions = page.locator('[data-thread-side-panel-new-tab-action-grid="true"]');
          await emptyActions.getByRole("button", { name: /^Files/ }).click();
          await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Open side panel tab", exact: true }).click();
          await page.getByRole("menuitem", { name: "Canvas", exact: true }).click();
          await expect(tabs(page)).toHaveCount(2);
          const retainedTabs = await readTabIdentities(page);
          expect(retainedTabs.every((tab) => tab.id)).toBe(true);
          expect(retainedTabs.some((tab) => tab.title === "Files")).toBe(true);
          claim(
            "Split Session titlebar keeps tabs, plus and workspace controls clickable",
            { blockedControls: [] },
            { blockedControls: (await readNativeDragRegions(page)).blockedControls },
          );
          await capture("session-split");
          await page.getByRole("button", { name: "Hide tabs", exact: true }).click();
          await page.mouse.move(900, 700);
          const showTabs = page.getByRole("button", { name: "Show tabs", exact: true });
          await expect(showTabs).toHaveAttribute("aria-description", "2 open tabs");
          await expect(tabs(page)).toHaveCount(0);
          await showTabs.hover();
          const retainedMenu = page.getByRole("menu", { name: "Open tabs", exact: true });
          await expect(retainedMenu).toBeVisible();
          claim(
            "Hidden Session content remains available through the hover chooser",
            { count: "2 open tabs", badge: "2", titles: retainedTabs.map((tab) => tab.title) },
            {
              count: await showTabs.getAttribute("aria-description"),
              badge: await showTabs.locator("svg + span").innerText(),
              titles: await retainedMenu
                .getByRole("menuitem")
                .evaluateAll((elements) =>
                  elements
                    .filter((element) => !element.getAttribute("aria-label")?.startsWith("Open "))
                    .map((element) => element.getAttribute("aria-label")),
                ),
            },
          );
          await capture("retained-tabs-hover");
          await showTabs.click();
          await expect(retainedMenu).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Hide tabs", exact: true })).toBeVisible();
          await expect(tabs(page)).toHaveCount(2);
          claim(
            "Clicking the count restores the same content in split view",
            retainedTabs,
            await readTabIdentities(page),
          );
          await page.getByRole("button", { name: "Enter full view", exact: true }).click();
          await expect(
            page.getByRole("button", { name: "Enter split view", exact: true }),
          ).toBeVisible();
          await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
          await page.mouse.move(900, 700);
          await expect(
            page.getByRole("button", { name: "Show sidebar", exact: true }),
          ).toBeVisible();
          const safeGeometry = await readNativeSafeGeometry(page);
          claim(
            "Full content and collapsed navigation preserve the native titlebar safe area",
            { controlsClearNativeSafeInset: true, tabsClearNativeSafeInset: true, surfaceTop: 44 },
            {
              controlsClearNativeSafeInset: safeGeometry.controlsClearNativeSafeInset,
              tabsClearNativeSafeInset: safeGeometry.tabsClearNativeSafeInset,
              surfaceTop: safeGeometry.surfaceTop,
            },
          );
          await writeFile(
            path.join(artifacts, "native-safe-geometry.json"),
            `${JSON.stringify({ nativeChrome, safeGeometry }, null, 2)}\n`,
          );
          await capture("session-full-native-safe");
          await page.getByRole("button", { name: "Enter split view", exact: true }).click();
          await expect(page.getByRole("button", { name: "Hide tabs", exact: true })).toBeVisible();
          claim(
            "Full view returns to split without replacing tab identities",
            retainedTabs,
            await readTabIdentities(page),
          );
          claim(
            "The tabs workflow uses a real threadless Session",
            { session: true, attachedThread: null },
            { session: Boolean(shellSession.sessionId), attachedThread: shellSession.threadId },
          );
          await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
          await page
            .getByRole("navigation", { name: "Home", exact: true })
            .getByRole("button", { name: "Open Relocation Alpha", exact: true })
            .click();
          await expectHomeProject();

          await rail(page).getByRole("button", { name: "Space", exact: true }).click();
          await expect(content(page)).toBeVisible();
          claim(
            "Home and Space share the sidebar title, search and first-row positions",
            homeHeader,
            await readSidebarHeader(page),
          );
          const standaloneRow = content(page).getByRole("listitem").filter({ hasText: PAGE_TITLE });
          if (!(await standaloneRow.isVisible())) {
            await content(page).getByRole("button", { name: "Show more", exact: true }).click();
          }
          await standaloneRow.click();
          await expectSpacePage();
          await content(page).getByRole("listitem").filter({ hasText: DATABASE_TITLE }).click();
          await expect(
            page.getByRole("tab", { name: DATABASE_TITLE, exact: true }),
          ).toHaveAttribute("aria-selected", "true");
          claim(
            "Space keeps two independently closable content tabs",
            { titles: [PAGE_TITLE, DATABASE_TITLE], closeButtons: 2 },
            {
              titles: await readTabLabels(page),
              closeButtons: await page.locator("[data-app-shell-tab-close-button]:visible").count(),
            },
          );
          await capture("space-tabs");

          await page.getByRole("tab", { name: PAGE_TITLE, exact: true }).click();
          await expectSpacePage();
          claim(
            "Selecting a content tab activates its Page through the strip",
            "true",
            await page
              .getByRole("tab", { name: PAGE_TITLE, exact: true })
              .getAttribute("aria-selected"),
          );
          await page.getByRole("tab", { name: DATABASE_TITLE, exact: true }).hover();
          await page
            .getByRole("button", { name: `Close ${DATABASE_TITLE} tab`, exact: true })
            .click();
          await expect(page.getByRole("tab", { name: DATABASE_TITLE, exact: true })).toHaveCount(0);
          claim(
            "Closing a content tab preserves the selected Page",
            { titles: [PAGE_TITLE] },
            {
              titles: await readTabLabels(page),
            },
          );

          await rail(page).getByRole("button", { name: "Home", exact: true }).click();
          await expectHomeProject();
          claim(
            "Home restores its Project checkpoint",
            ["Project Home"],
            await readTabLabels(page),
          );
          await rail(page).getByRole("button", { name: "Space", exact: true }).click();
          await expectSpacePage();
          claim(
            "Space preserves its content checkpoint independently of Home",
            [PAGE_TITLE],
            await readTabLabels(page),
          );

          await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
          await page.mouse.move(1200, 740);
          await expect(
            page.getByRole("button", { name: "Show sidebar", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("navigation", { name: "Space", exact: true }),
          ).not.toBeVisible();
          claim(
            "Collapsing the contextual sidebar retains the navigation rail",
            { railVisible: true, railWidth: 52, spaceSidebarVisible: false },
            {
              railVisible: await rail(page).isVisible(),
              railWidth: (await rail(page).boundingBox())?.width,
              spaceSidebarVisible: await page
                .getByRole("navigation", { name: "Space", exact: true })
                .isVisible(),
            },
          );
          await capture("collapsed-sidebar");
          await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
          await page.mouse.move(1200, 740);
          await expect(content(page)).toBeVisible();

          await page.getByRole("button", { name: "Settings", exact: true }).click();
          await expect(page.getByRole("link", { name: "General", exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Back to app", exact: true }).click();
          await expectSpacePage();
          claim(
            "Settings returns to the existing Space content",
            [PAGE_TITLE],
            await readTabLabels(page),
          );
          await page.setViewportSize({ width: 760, height: 800 });
          await expectSpacePage();
          claim(
            "Narrow Workbench has no horizontal window overflow",
            { shell: 0, document: 0 },
            await readOverflow(page),
          );
          await capture("narrow");
          claim(
            "Narrow resize produces no panel action error toast",
            0,
            // Every toast is an alert; unrelated notices (such as onboarding nudges) may appear.
            await page.getByRole("alert").filter({ hasText: /panel/iu }).count(),
          );
          await page.setViewportSize({ width: 1280, height: 800 });
          await page.mouse.move(1200, 740);
          await capture("before-restart");
          await recording.screencast.stop();
          recording = undefined;

          page = await harness.restart();
          page.on("pageerror", (error) => rendererErrors.push(error.message));
          await page.setViewportSize({ width: 1280, height: 800 });
          await expectSpacePage();
          claim(
            "Cold reopen restores Space and its content tab",
            { destination: "page", titles: [PAGE_TITLE], dark: true },
            {
              destination: await rail(page)
                .getByRole("button", { name: "Space", exact: true })
                .getAttribute("aria-current"),
              titles: await readTabLabels(page),
              dark: (await readPaint(page)).dark,
            },
          );
          await rail(page).getByRole("button", { name: "Home", exact: true }).click();
          await expectHomeProject();
          claim(
            "Cold reopen retains the Home Project checkpoint",
            ["Project Home"],
            await readTabLabels(page),
          );
          await page.screenshot({ path: path.join(artifacts, "reopened-home.png") });
          const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
          if (await showSidebar.isVisible()) await showSidebar.click();
          await page.mouse.move(1200, 740);
          await expect(page.getByTestId("app-shell-floating-left-panel")).toHaveCount(0);
          await expect(page.getByRole("navigation", { name: "Home", exact: true })).toBeVisible();
          await page
            .getByRole("navigation", { name: "Home", exact: true })
            .getByRole("button", { name: "Inbox", exact: true })
            .click();
          await expect(page.getByTestId("inbox-route")).toBeVisible();
          claim(
            "Home opens the actual Inbox route",
            { homeDestination: "page", inboxVisible: true },
            {
              homeDestination: await rail(page)
                .getByRole("button", { name: "Home", exact: true })
                .getAttribute("aria-current"),
              inboxVisible: await page.getByTestId("inbox-route").isVisible(),
            },
          );
          await page.getByRole("button", { name: "Settings", exact: true }).click();
          await expect(page.getByRole("link", { name: "General", exact: true })).toBeVisible();
          claim(
            "Settings opened from Inbox retains the Home destination",
            "page",
            await rail(page)
              .getByRole("button", { name: "Home", exact: true })
              .getAttribute("aria-current"),
          );
          await page.getByRole("button", { name: "Back to app", exact: true }).click();
          await expect(page.getByTestId("inbox-route")).toBeVisible();
          claim(
            "Settings returns to Home Inbox without entering Space",
            { homeDestination: "page", inboxVisible: true },
            {
              homeDestination: await rail(page)
                .getByRole("button", { name: "Home", exact: true })
                .getAttribute("aria-current"),
              inboxVisible: await page.getByTestId("inbox-route").isVisible(),
            },
          );
          await page.screenshot({ path: path.join(artifacts, "inbox-return.png") });
          await page
            .getByRole("navigation", { name: "Home", exact: true })
            .getByRole("button", { name: "Open Relocation Alpha", exact: true })
            .click();
          await expectHomeProject();
          await rail(page).getByRole("button", { name: "Space", exact: true }).click();
          await expectSpacePage();
          claim(
            "Shell navigation produces no error toasts",
            0,
            await page.getByRole("alert").count(),
          );
          claim("Shell navigation produces no renderer errors", [], rendererErrors);
          await page.mouse.move(1200, 740);
          await capture("final");
          status = "passed";
        } catch (error) {
          await page
            .screenshot({ path: path.join(artifacts, "failure.png") })
            .catch(() => undefined);
          const accessibility = await page
            .locator("body")
            .ariaSnapshot()
            .catch(() => null);
          if (accessibility)
            await writeFile(path.join(artifacts, "failure-aria.txt"), accessibility);
          throw error;
        } finally {
          await recording?.screencast.stop().catch(() => undefined);
        }
      },
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await writeFile(
      path.join(artifacts, "result.json"),
      `${JSON.stringify({ status, fixture: PAGE_RELOCATION_SCENARIO_ID, appearanceMode: "dark", claims, failure }, null, 2)}\n`,
    );
    await writeFile(
      path.join(artifacts, "README.md"),
      `# Home and Space verification\n\nStatus: **${status}**\n\nA fresh public-operation Profile runs the Page relocation scenario. Home remembers the Project, Space owns two closable content tabs selected through their strip, and Settings returns to Space. A real Session preserves its retained content while tabs are hidden, restored, and expanded. Global titlebar hierarchy and native window-button geometry are checked. The Dark renderer recording uses the natural opaque fallback after the owned window loses focus; it includes sidebar collapse and a narrow window. OS native Traffic Lights are verified through the owned BrowserWindow and are outside renderer capture. Light paint, a cold Electron reopen, and Home Inbox returning from Settings are checked separately. Exact expected and actual values are in result.json.\n${failure ? `\nFailure: ${failure}\n` : ""}`,
    );
  }
});
