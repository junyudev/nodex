import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { openProjectBoard } from "../../scripts/scenarios/harness/project-board-ui";
import {
  PAGE_FILE_PROVENANCE_MIXED_PAGE_KEY,
  PAGE_FILE_PROVENANCE_REPORT_PAGE_KEY,
  PAGE_FILE_PROVENANCE_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/page-file-provenance";

/**
 * Review screenshots go to `PAGE_FILE_TABS_ARTIFACTS` when set, else to the test output. The
 * window captures itself, so the isolated report guest is composited where the person sees it.
 */
const shot = async (application: ElectronApplication, name: string, theme: "light" | "dark") => {
  const directory = process.env.PAGE_FILE_TABS_ARTIFACTS;
  const file = `${name}-${theme}.png`;
  const png = await application.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"),
  );
  await writeFile(
    directory ? path.join(directory, file) : test.info().outputPath(file),
    Buffer.from(png, "base64"),
  );
};

/** The app follows the emulated system theme; the operating system theme stays as it is. */
const setTheme = async (page: Page, theme: "light" | "dark") => {
  await page.emulateMedia({ colorScheme: theme });
};

const openPage = async (page: Page, pageId: string) => {
  await page
    .getByRole("button", { name: "Open lumen-web", exact: true })
    .evaluate((element) => (element as HTMLElement).click());
  await openProjectBoard(page);
  await page
    .locator(`[data-board-uuid-v7="${pageId}"] [data-card-context-menu-trigger="true"]`)
    .evaluate((element) => (element as HTMLElement).click());
  const stage = page.locator(`[data-page-stage-page-id="${pageId}"]:visible`);
  await stage.waitFor();
  return stage;
};

/** Reads the rendered report inside its isolated guest, which the app renderer cannot reach. */
const readReport = (application: ElectronApplication) =>
  application.evaluate(async ({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().startsWith("nodex-page-file://"));
    if (!guest) return null;
    return (await guest.executeJavaScript(
      `({
        title: document.querySelector("h1")?.textContent,
        today: document.getElementById("today")?.textContent,
        flamegraph: document.querySelector("img")?.naturalWidth ?? 0,
        bridge: typeof window.api,
        width: window.innerWidth,
        dark: matchMedia("(prefers-color-scheme: dark)").matches,
      })`,
    )) as {
      title: string;
      today: string;
      flamegraph: number;
      bridge: string;
      width: number;
      dark: boolean;
    };
  });

for (const theme of ["light", "dark"] as const) {
  test(`opens an Agent's Page Files beside their Page (${theme})`, async () => {
    test.setTimeout(240_000);
    await withElectronScenario(
      {
        label: `page-file-tabs-${theme}`,
        scenarioId: PAGE_FILE_PROVENANCE_SCENARIO_ID,
        seedThrough: "core",
      },
      async ({ application, page, manifest }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        if (!manifest) throw new Error("page/file-provenance did not materialize");
        await application.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
        });
        await setTheme(page, theme);

        const reportPageId = manifest.pageIdsByKey[PAGE_FILE_PROVENANCE_REPORT_PAGE_KEY]!;
        const stage = await openPage(page, reportPageId);

        // One chat attached every File, so the summary names it and the rows do not repeat it.
        const summary = stage.getByRole("button", { name: /^3 files/u });
        await expect(summary).toHaveAttribute("aria-expanded", "true");
        await expect(stage.getByText("From", { exact: true })).toBeVisible();
        await expect(
          stage
            .locator("[data-page-files-property]")
            .getByRole("button", { name: "Dashboard cold start" }),
        ).toBeVisible();
        const tree = stage.getByRole("tree", { name: "Page files" });
        for (const name of ["profile", "profile/report.html", "profile/flamegraph.png"]) {
          await expect(tree.getByRole("treeitem", { name, exact: true })).toBeVisible();
        }
        await shot(application, "page-files-tree", theme);

        // The report opens beside its Page and renders, with its sibling image and data.
        await tree.getByRole("treeitem", { name: "profile/report.html" }).click();
        const reportTab = page.getByRole("tab", { name: /report\.html/u });
        await expect(reportTab).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tab", { name: /Dashboard cold start/u })).toBeVisible();
        await expect(page.locator('[data-page-file-viewer="html"]:visible')).toBeVisible();
        await expect
          .poll(() => readReport(application), { timeout: 30_000 })
          .toMatchObject({
            title: "Dashboard cold start",
            today: "2.3 s",
            flamegraph: 2400,
            bridge: "undefined",
            // The report answers its own color-scheme query with the app's theme.
            dark: theme === "dark",
          });
        // The report lays out in the tab's own width, not the window's.
        const box = await page.locator('webview[aria-label="Page File preview"]').boundingBox();
        expect(Math.abs((await readReport(application))!.width - box!.width)).toBeLessThan(2);
        await page.waitForTimeout(800);
        await shot(application, "report-html-tab", theme);

        // The breadcrumb returns to the Page; the flame graph opens in its image viewer.
        await page
          .locator('[data-page-file-viewer="html"]:visible')
          .getByRole("button", { name: "Dashboard cold start" })
          .click();
        await expect(page.getByRole("tab", { name: /Dashboard cold start/u })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await tree.getByRole("treeitem", { name: "profile/flamegraph.png" }).dblclick();
        const image = page.locator('[data-page-file-viewer="image"]:visible img');
        await expect(image).toBeVisible();
        await expect
          .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
          .toBe(2400);
        await expect(page.getByText(/^2400 × 720 · \d+ KB$/u)).toBeVisible();
        await shot(application, "image-tab", theme);

        // Mixed origins move to the narrowest node they cover.
        const mixedPageId = manifest.pageIdsByKey[PAGE_FILE_PROVENANCE_MIXED_PAGE_KEY]!;
        const mixed = await openPage(page, mixedPageId);
        const mixedTree = mixed.getByRole("tree", { name: "Page files" });
        await expect(mixed.getByRole("button", { name: /^3 files/u })).toBeVisible();
        await expect(mixed.getByText("From", { exact: true })).toHaveCount(0);
        await expect(mixedTree.getByRole("treeitem", { name: "brief.md" })).toContainText("You");
        await expect(
          mixedTree.getByRole("treeitem", { name: "mockups", exact: true }),
        ).toContainText("Settings dark mode");
        await expect(mixedTree.getByText(/^In page\s*1$/u)).toBeVisible();
        await shot(application, "page-files-mixed", theme);
        expect(pageErrors).toEqual([]);
      },
    );
  });
}
