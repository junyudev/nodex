import type { Page } from "playwright";

import type { ScenarioManifest } from "../contracts";
import { LIBRARY_FILES_PAGE_A_KEY } from "./library-files";

export const focusLibraryFilesProjectHome = async (
  page: Page,
  manifest: ScenarioManifest,
): Promise<void> => {
  const pageAId = manifest.pageIdsByKey[LIBRARY_FILES_PAGE_A_KEY];
  if (!pageAId) throw new Error("library/files manifest has no Page A");
  const pageACard = page.locator(`[data-board-uuid-v7="${pageAId}"]`);
  if (await pageACard.isVisible().catch(() => false)) return;
  await page
    .getByRole("button", { name: "Open Library Files Lab", exact: true })
    .evaluate((element) => (element as HTMLElement).click());
  await page.getByRole("tab", { name: "Project Home" }).waitFor();
  await pageACard.waitFor();
};

export const openLibraryFilesPage = async (
  page: Page,
  manifest: ScenarioManifest,
  pageKey: string,
  title: string,
): Promise<void> => {
  const pageId = manifest.pageIdsByKey[pageKey];
  if (!pageId) throw new Error(`library/files manifest has no ${pageKey}`);
  const tab = page.getByRole("tab", { name: title });
  if (
    (await tab.isVisible().catch(() => false)) &&
    (await tab.getAttribute("aria-selected")) === "true"
  ) {
    return;
  }
  await focusLibraryFilesProjectHome(page, manifest);
  await page
    .locator(`[data-board-uuid-v7="${pageId}"] [data-card-context-menu-trigger="true"]`)
    .evaluate((element) => (element as HTMLElement).click());
  await tab.waitFor();
  await page.locator(`[data-page-stage-page-id="${pageId}"]:visible`).waitFor();
};
