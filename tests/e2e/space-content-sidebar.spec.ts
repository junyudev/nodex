import { expect, test, type Locator, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { openSpace } from "../../scripts/scenarios/harness/space-ui";
import {
  requireSpaceContentScenarioFacts,
  SPACE_CONTENT_PAGE_TITLES,
  SPACE_CONTENT_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/space-content";

const contentList = (page: Page): Locator =>
  page
    .getByRole("navigation", { name: "Space", exact: true })
    .getByRole("list", { name: "Content", exact: true });

const contentRows = (page: Page): Locator =>
  contentList(page)
    .getByRole("listitem")
    .filter({ hasNot: page.getByRole("button", { name: /^Show (more|less)$/u }) });

const readContentTitles = async (page: Page): Promise<string[]> =>
  await contentRows(page).evaluateAll((rows) => rows.map((row) => row.textContent?.trim() ?? ""));

const showMore = async (page: Page): Promise<void> => {
  await page
    .getByRole("navigation", { name: "Space", exact: true })
    .getByRole("button", { name: "Show more", exact: true })
    .click();
};

const PAGE_TITLES: readonly string[] = SPACE_CONTENT_PAGE_TITLES;

test("Space Content keeps its order and remembered depth while content opens", async ({}, testInfo) => {
  test.setTimeout(150_000);
  await withElectronScenario(
    {
      label: "space-content-sidebar",
      scenarioId: SPACE_CONTENT_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("space-content-runtime-logs", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
        if (screenshot) {
          await testInfo.attach("space-content-failure", {
            body: screenshot,
            contentType: "image/png",
          });
        }
      },
    },
    async ({ harness, page: initialPage, facts }) => {
      requireSpaceContentScenarioFacts(facts);
      let page = initialPage;
      await openSpace(page);
      await expect(contentRows(page)).toHaveCount(5);

      await showMore(page);
      await expect(contentRows(page)).toHaveCount(15);
      await showMore(page);
      await expect(contentRows(page)).toHaveCount(25);
      const revealed = await readContentTitles(page);
      const revealedPages = revealed.filter((title) => PAGE_TITLES.includes(title));
      expect(revealedPages).toEqual(PAGE_TITLES.slice(0, revealedPages.length));

      // Opening rows deep in the list never reorders Content or forgets how much is revealed.
      for (const title of ["Team rituals", "Retrospectives", "Hiring plan"]) {
        await contentRows(page).filter({ hasText: title }).click();
        await expect(page.getByRole("tab", { name: title, exact: true })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(contentRows(page).filter({ hasText: title })).toHaveAttribute(
          "aria-current",
          "page",
        );
        expect(await readContentTitles(page)).toEqual(revealed);
      }

      await page
        .getByRole("navigation", { name: "App navigation", exact: true })
        .getByRole("button", { name: "Home", exact: true })
        .click();
      await openSpace(page);
      await expect.poll(() => readContentTitles(page)).toEqual(revealed);

      page = await harness.restart();
      await openSpace(page);
      await expect.poll(() => readContentTitles(page)).toEqual(revealed);

      await page
        .getByRole("navigation", { name: "Space", exact: true })
        .getByRole("button", { name: "Show less", exact: true })
        .click();
      // The open Page beyond the first page stays listed as one extra row in Library order.
      await expect
        .poll(() => readContentTitles(page))
        .toEqual([...revealed.slice(0, 5), "Hiring plan"]);
    },
  );
});
