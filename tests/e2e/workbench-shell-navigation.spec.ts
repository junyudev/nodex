import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  PAGE_RELOCATION_SCENARIO_ID,
  requirePageRelocationScenarioFacts,
} from "../../scripts/scenarios/scenarios/page-relocation";

interface EvidenceClaim {
  name: string;
  expected: unknown;
  actual: unknown;
}

const PAGE_TITLE = "Sidebar Page to move";
const DATABASE_TITLE = "Relocation Alpha DB";
const rail = (page: Page) => page.getByRole("navigation", { name: "App navigation", exact: true });
const tabs = (page: Page) => page.locator('[data-app-shell-tab-controller] [role="tab"]:visible');
const openTabs = (page: Page) =>
  page.getByRole("button", { name: "Open tabs", exact: true }).filter({ visible: true });
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

const readGeometry = async (page: Page) =>
  page.evaluate(() => {
    const navigation = document.querySelector("[data-app-navigation-rail]");
    const header = document.querySelector('[data-testid="workbench-global-header"]');
    const pill = Array.from(document.querySelectorAll("[data-app-shell-tab-surface]")).find(
      (element) => element.getBoundingClientRect().width > 0,
    );
    const pane = pill?.closest(".main-surface");
    const tabHitTarget = pill?.querySelector('[role="tab"]');
    if (!navigation || !header || !pill || !pane || !tabHitTarget)
      throw new Error("Missing Workbench geometry surface");
    const railBounds = navigation.getBoundingClientRect();
    const paneBounds = pane.getBoundingClientRect();
    return {
      rail: { width: railBounds.width, top: railBounds.top },
      buttons: Array.from(navigation.querySelectorAll("button")).map((button) => {
        const bounds = button.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }),
      headerHeight: header.getBoundingClientRect().height,
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
    const main = document.querySelector(".main-surface");
    if (!navigation || !shell || !header || !main)
      throw new Error("Missing Workbench paint surface");
    const background = getComputedStyle(main).backgroundColor;
    const sidebarRole = getComputedStyle(shell)
      .getPropertyValue("--color-token-side-bar-background")
      .trim();
    const alpha = background.startsWith("rgba(")
      ? background.slice(background.lastIndexOf(",") + 1, -1).trim()
      : (background.split("/")[1]?.replace(")", "").trim() ?? "1");
    return {
      windowType: document.documentElement.getAttribute("data-codex-window-type"),
      electronOpaque: document.documentElement.classList.contains("electron-opaque"),
      shellBackground: getComputedStyle(shell).backgroundColor,
      railBackground: getComputedStyle(navigation).backgroundColor,
      headerBackground: getComputedStyle(header).backgroundColor,
      sidebarRole,
      sidebarRoleDefined: sidebarRole.length > 0,
      mainBackground: background,
      mainOpaque: alpha === "100%" || Number.parseFloat(alpha) === 1,
      dark: document.documentElement.classList.contains("dark"),
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
      async ({ page: initialPage, harness, facts }) => {
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

          await selectAppearance(page, "Light");
          await expectHomeProject();
          const lightPaint = await readPaint(page);
          claim(
            "Light chrome preserves native sidebar material and opaque content",
            {
              windowType: "electron",
              electronOpaque: false,
              shellBackground: "rgba(0, 0, 0, 0)",
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
            "Dark chrome preserves native material with a distinct sidebar role",
            {
              windowType: "electron",
              electronOpaque: false,
              shellBackground: "rgba(0, 0, 0, 0)",
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
                { width: 36, height: 36 },
                { width: 36, height: 36 },
              ],
              headerHeight: 44,
              tabPillHeight: 32,
              tabHitHeight: 32,
              paneInsets: { right: 4, bottom: 4 },
            },
            await readGeometry(page),
          );
          await page.screencast.start({
            path: path.join(artifacts, "review.webm"),
            size: { width: 1280, height: 800 },
            annotate: { position: "bottom", fontSize: 14 },
          });
          recording = page;
          await capture("home");

          await rail(page).getByRole("button", { name: "Space", exact: true }).click();
          await expect(content(page)).toBeVisible();
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
          await expect(openTabs(page)).toHaveAttribute("aria-description", "2 open tabs");
          claim(
            "Space keeps two independently closable content tabs",
            { titles: [PAGE_TITLE, DATABASE_TITLE], closeButtons: 2 },
            {
              titles: await readTabLabels(page),
              closeButtons: await page.locator("[data-app-shell-tab-close-button]:visible").count(),
            },
          );
          await capture("space-tabs");

          await openTabs(page).hover();
          const menu = page.getByRole("menu", { name: "Open tabs", exact: true });
          await expect(menu).toBeVisible();
          claim(
            "Open tabs hover exposes both tabs and the exact count",
            {
              count: "2 open tabs",
              badge: "2",
              items: [PAGE_TITLE, DATABASE_TITLE],
              selected: DATABASE_TITLE,
            },
            {
              count: await openTabs(page).getAttribute("aria-description"),
              badge: await openTabs(page).locator("svg + span").innerText(),
              items: await menu
                .getByRole("menuitem")
                .evaluateAll((elements) =>
                  elements.map((element) => element.getAttribute("aria-label")),
                ),
              selected: await menu.locator('[aria-current="true"]').getAttribute("aria-label"),
            },
          );
          await capture("open-tabs");
          await menu.getByRole("menuitem", { name: PAGE_TITLE, exact: true }).click();
          await expect(menu).toHaveCount(0);
          await expectSpacePage();
          claim(
            "Selecting an Open tabs item activates its Page",
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
          await expect(openTabs(page)).toHaveAttribute("aria-description", "1 open tab");
          claim(
            "Closing a content tab updates the surviving tab and count",
            { titles: [PAGE_TITLE], count: "1 open tab", badge: "1" },
            {
              titles: await readTabLabels(page),
              count: await openTabs(page).getAttribute("aria-description"),
              badge: await openTabs(page).locator("svg + span").innerText(),
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
      `# Home and Space verification\n\nStatus: **${status}**\n\nA fresh public-operation Profile runs the Page relocation scenario. Home remembers the Project, Space owns two closable content tabs, Open tabs selects and counts them, and Settings returns to Space. The native Dark recording includes sidebar collapse and a narrow window. Light paint, a cold Electron reopen, and Home Inbox returning from Settings are checked separately. Exact expected and actual values are in result.json.\n${failure ? `\nFailure: ${failure}\n` : ""}`,
    );
  }
});
