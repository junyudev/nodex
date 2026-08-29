import { expect, test, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  requireSidebarCustomSectionsFacts,
  SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/sidebar-custom-sections";

const workSection = (page: Page) =>
  page.locator('[data-app-action-sidebar-section-heading="Work"]');
const projectsSection = (page: Page) =>
  page.locator('[data-app-action-sidebar-section-heading="Projects"]');

async function dragSidebarRow(
  source: import("@playwright/test").Locator,
  target: import("@playwright/test").Locator,
  indicatorScope: import("@playwright/test").Locator,
  targetYRatio = 0.35,
) {
  await expect
    .poll(async () => {
      const box = await source.boundingBox();
      if (!box) return false;
      return await source.evaluate(
        (element, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return hit !== null && (hit === element || element.contains(hit));
        },
        { x: box.x + box.width * 0.55, y: box.y + box.height / 2 },
      );
    })
    .toBe(true);
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Sidebar drag endpoints are not visible");
  const sourceX = sourceBox.x + sourceBox.width * 0.55;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + targetBox.width * 0.55;
  const targetY = targetBox.y + targetBox.height * targetYRatio;
  const mouse = source.page().mouse;
  let pointerReleased = false;
  await mouse.move(sourceX, sourceY);
  await mouse.down();
  try {
    await mouse.move(sourceX, sourceY + 8, { steps: 3 });
    await expect(
      source.page().locator('[aria-pressed="true"][aria-roledescription="sortable"]'),
    ).toHaveCount(1);
    await mouse.move(targetX, targetY, { steps: 12 });
    await mouse.move(targetX, targetY + 1, { steps: 2 });
    await expect(indicatorScope.locator('[role="presentation"]')).toHaveCount(1);
    await mouse.up();
    pointerReleased = true;
  } finally {
    if (!pointerReleased) await mouse.up();
  }
}

test("moves Chats and Projects into a custom Section at mixed row boundaries", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withElectronScenario(
    {
      label: "sidebar-custom-sections-dnd",
      scenarioId: SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("sidebar-custom-sections-dnd-runtime-logs", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
        if (screenshot) {
          await testInfo.attach("sidebar-custom-sections-dnd-failure", {
            body: screenshot,
            contentType: "image/png",
          });
        }
      },
    },
    async ({ application, facts, page }) => {
      if (!facts) throw new Error("Sidebar Section scenario did not materialize");
      requireSidebarCustomSectionsFacts(facts);
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
      });

      const projects = projectsSection(page);
      const work = workSection(page);
      await expect(work).toBeVisible();
      await expect(projects.getByRole("button", { name: "New section" })).toHaveCount(0);

      const inboxProject = projects.locator(
        '[data-app-action-sidebar-project-label="Inbox Project"]',
      );
      await inboxProject.hover();
      await inboxProject.getByRole("button", { name: "Expand project" }).click();
      const inboxChat = projects.locator('[data-app-action-sidebar-thread-title="Inbox chat"]');
      const sectionProject = work.locator(
        '[data-app-action-sidebar-project-label="Section Project"]',
      );
      await expect(inboxChat).toBeVisible();
      const inboxProjectLabel = projects.getByRole("button", {
        name: "Open Inbox Project",
        exact: true,
      });
      await dragSidebarRow(inboxProjectLabel, sectionProject, work);
      const movedProjectGroup = work.getByRole("listitem", {
        name: "Inbox Project",
        exact: true,
      });
      const movedProject = movedProjectGroup.locator(
        '[data-app-action-sidebar-project-label="Inbox Project"]',
      );
      await expect(movedProject).toBeVisible();
      await expect(inboxProjectLabel).toHaveCount(0);
      await expect(movedProject.getByRole("button", { name: "Collapse project" })).toBeAttached();
      await expect(
        movedProject.getByRole("button", { name: "Project actions for Inbox Project" }),
      ).toBeAttached();
      await expect(
        movedProject.getByRole("button", { name: "Start new chat in Inbox Project" }),
      ).toBeAttached();
      await expect(
        movedProject.getByRole("button", { name: "Open Inbox Project", exact: true }),
      ).toBeAttached();
      await expect(movedProject.locator('[data-app-action-sidebar-project-marker=""]')).toHaveCount(
        1,
      );
      await expect(
        movedProjectGroup.locator('[data-app-action-sidebar-thread-title="Inbox chat"]'),
      ).toBeVisible();

      // Project centers accept a Chat into the Project; its top edge remains the
      // mixed Section boundary immediately before that Project.
      const movedProjectChat = movedProjectGroup.locator(
        '[data-app-action-sidebar-thread-title="Inbox chat"]',
      );
      await dragSidebarRow(movedProjectChat, sectionProject, work, 0.1);
      const movedChat = work.locator('[data-app-action-sidebar-thread-title="Inbox chat"]');
      await expect(movedChat).toBeVisible();
      await expect(
        movedProjectGroup.locator('[data-app-action-sidebar-thread-title="Inbox chat"]'),
      ).toHaveCount(0);
    },
  );
});

test("persists custom Section disclosure and safely restores an Undoable deletion", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withElectronScenario(
    {
      label: "sidebar-custom-sections",
      scenarioId: SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("sidebar-custom-sections-runtime-logs", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
        if (screenshot) {
          await testInfo.attach("sidebar-custom-sections-failure", {
            body: screenshot,
            contentType: "image/png",
          });
        }
      },
    },
    async ({ application, facts, harness, page }) => {
      if (!facts) throw new Error("Sidebar Section scenario did not materialize");
      const observed = requireSidebarCustomSectionsFacts(facts);
      expect(observed.directItemCount).toBe(53);
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
      });

      const section = workSection(page);
      await expect(section).toBeVisible();
      await expect(section.locator('[data-activity-spinner="true"]')).toBeVisible();
      await expect(section.getByRole("button", { name: "Show more" })).toBeVisible();
      await section.getByRole("button", { name: "Show more" }).click();
      await expect(section.getByText("Section draft 51", { exact: true })).toBeVisible();

      const disclosure = section.locator('[data-app-action-sidebar-section-toggle=""]');
      await disclosure.click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(section.locator('[data-activity-spinner="true"]')).toBeVisible();
      await page.waitForTimeout(350);

      const restartedPage = await harness.restart();
      const restoredSection = workSection(restartedPage);
      await expect(restoredSection).toBeVisible();
      await expect(
        restoredSection.locator('[data-app-action-sidebar-section-toggle=""]'),
      ).toHaveAttribute("aria-expanded", "false");

      await restoredSection.getByText("Work", { exact: true }).hover();
      const sectionActions = restoredSection.getByRole("button", {
        name: "Section actions for Work",
      });
      await expect(sectionActions).toBeVisible();
      await sectionActions.click();
      await expect(restartedPage.getByRole("menuitem", { name: "Move section up" })).toHaveCount(0);
      await expect(restartedPage.getByRole("menuitem", { name: "Move section down" })).toHaveCount(
        0,
      );
      await restartedPage.getByRole("menuitem", { name: "Delete section" }).click();
      await expect(workSection(restartedPage)).toHaveCount(0);
      await restartedPage.getByRole("button", { name: "Undo" }).click();
      await expect(workSection(restartedPage)).toBeVisible();
    },
  );
});
