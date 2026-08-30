import { expect, test, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  PAGE_RELOCATION_SCENARIO_ID,
  requirePageRelocationScenarioFacts,
} from "../../scripts/scenarios/scenarios/page-relocation";

const openSourcePageMenu = async (page: Page, pageId: string): Promise<void> => {
  const target = page.locator(`[data-database-view-page-menu-target="${pageId}"]`);
  if (!(await target.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open Relocation Alpha", exact: true }).click();
    await page.getByRole("tab", { name: "Project Home", exact: true }).waitFor();
  }
  await target.waitFor();
  await target.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Move to", exact: true })).toBeVisible();
};

test("moves a Database Page across Projects and undoes the relocation", async ({}, testInfo) => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: "page-relocation",
      scenarioId: PAGE_RELOCATION_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("page-relocation-runtime-logs", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const accessibility = await page
          ?.locator("body")
          .ariaSnapshot()
          .catch(() => null);
        if (accessibility) {
          await testInfo.attach("page-relocation-accessibility", {
            body: Buffer.from(accessibility),
            contentType: "text/plain",
          });
        }
        const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
        if (screenshot) {
          await testInfo.attach("page-relocation-failure", {
            body: screenshot,
            contentType: "image/png",
          });
        }
      },
    },
    async ({ page, facts }) => {
      if (!facts) throw new Error("Database Page relocation scenario did not materialize");
      const relocation = requirePageRelocationScenarioFacts(facts);
      await openSourcePageMenu(page, relocation.sourcePageId);

      await expect(page.getByRole("menuitem", { name: "Reorder", exact: true })).toHaveCount(0);
      const moveTo = page.getByRole("menuitem", { name: "Move to", exact: true });
      await moveTo.hover();
      const search = page.getByRole("combobox", { name: "Move Move this Page to" });
      await expect(search).toBeVisible();
      await search.pressSequentially("Relocation Beta");
      const betaDatabase = page.getByRole("option").filter({ hasText: "Relocation Beta" }).first();
      await expect(betaDatabase).toBeVisible();
      await betaDatabase.click();

      const sourceTarget = page.locator(
        `[data-database-view-page-menu-target="${relocation.sourcePageId}"]`,
      );
      await expect(sourceTarget).toHaveCount(0, { timeout: 15_000 });
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await expect(undo).toBeVisible();
      await undo.click();
      await expect(page.getByText("Move undone", { exact: true })).toBeVisible();
      await expect(sourceTarget).toBeVisible({ timeout: 15_000 });
    },
  );
});

test("moves a Sidebar Page into a Database and restores its Library position", async () => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: "sidebar-page-relocation",
      scenarioId: PAGE_RELOCATION_SCENARIO_ID,
    },
    async ({ page, facts }) => {
      if (!facts) throw new Error("Page relocation scenario did not materialize");
      const relocation = requirePageRelocationScenarioFacts(facts);
      const sidebarPage = page.getByText("Sidebar Page to move", { exact: true });
      await expect(sidebarPage).toBeVisible();
      await sidebarPage.hover();
      await page
        .getByRole("button", { name: "Actions for Sidebar Page to move", exact: true })
        .click();
      const moveTo = page.getByRole("menuitem", { name: "Move to", exact: true });
      await moveTo.hover();
      const search = page.getByRole("combobox", { name: "Move Sidebar Page to move to" });
      await expect(search).toBeVisible();
      await search.pressSequentially("Relocation Beta");
      const betaDatabase = page.getByRole("option").filter({ hasText: "Relocation Beta" }).first();
      await expect(betaDatabase).toBeVisible();
      await betaDatabase.click();

      await expect(sidebarPage).toHaveCount(0, { timeout: 15_000 });
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await expect(undo).toBeVisible();
      await undo.click();
      await expect(page.getByText("Move undone", { exact: true })).toBeVisible();
      await expect(sidebarPage).toBeVisible({ timeout: 15_000 });
      expect(relocation.standalonePageId).toBeTruthy();
    },
  );
});

test("shows Reorder only when its startup feature is enabled", async () => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: "database-page-reorder-gate",
      scenarioId: PAGE_RELOCATION_SCENARIO_ID,
      enabledFeatures: ["database-page-reorder-menu"],
    },
    async ({ page, facts }) => {
      if (!facts) throw new Error("Database Page relocation scenario did not materialize");
      const relocation = requirePageRelocationScenarioFacts(facts);
      await openSourcePageMenu(page, relocation.sourcePageId);

      await expect(page.getByRole("menuitem", { name: "Move to", exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Reorder", exact: true })).toBeVisible();
    },
  );
});
