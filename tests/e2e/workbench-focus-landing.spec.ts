import { expect, test } from "@playwright/test";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { landingSharedPagesScenario } from "../../scripts/scenarios/scenarios/landing-showcase";

test("Workbench lands the keyboard after chat, history, and Project navigation @automatic", async () => {
  await withElectronScenario(
    {
      label: "workbench-focus-landing",
      scenarioId: landingSharedPagesScenario.id,
      seedThrough: "core",
    },
    async ({ page, manifest, seed }) => {
      const chatId = manifest?.entityIdsByKey?.chat;
      if (!manifest || !chatId) throw new Error("The Project and its chat were not seeded");

      const project = page.locator(
        `[data-app-action-sidebar-project-id="${manifest.projectId}"]:visible`,
      );
      const openProject = project.getByRole("button", { name: "Open Tinyboard", exact: true });
      const chat = page.locator(
        '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-title="Update implementation notes"]:visible',
      );
      const session = page.locator(`[data-workbench-scene-owner="session:${chatId}"]:visible`);
      const composer = page.locator("[data-codex-composer='true']:visible");
      const projectScene = page.locator(
        `[data-workbench-scene-owner="project:${manifest.projectId}"]:visible`,
      );
      const inbox = projectScene.getByRole("textbox", { name: "Message your Inbox" });

      await test.step("opening the active Project Home focuses its Inbox", async () => {
        await openProject.click();
        await expect(inbox).toBeFocused();
        await project.hover();
        const expand = project.getByRole("button", { name: "Expand project", exact: true });
        if (await expand.isVisible()) await expand.click();
      });

      await test.step("the sidebar lands in the chat and history restores the Inbox", async () => {
        await inbox.focus();
        await chat.click();
        await expect(session.locator(composer)).toBeFocused();
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await expect(inbox).toBeFocused();
        await page.getByRole("button", { name: "Forward", exact: true }).click();
        await expect(session.locator(composer)).toBeFocused();
      });

      await test.step("reopening a Project preserves its active tab until Open Inbox", async () => {
        await openProject.click();
        await expect(inbox).toBeFocused();
        await projectScene.getByRole("button", { name: "Open Board", exact: true }).click();
        await expect(inbox).toHaveCount(0);
        const boardTab = page
          .locator('[data-panel-tab-row^="right:"]')
          .getByRole("tab", { selected: true });
        await boardTab.focus();
        await chat.click();
        await expect(session.locator(composer)).toBeFocused();
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await expect(boardTab).toBeFocused();
        await page.getByRole("button", { name: "Forward", exact: true }).click();
        await expect(session.locator(composer)).toBeFocused();
        await openProject.click();
        await expect(projectScene).toBeVisible();
        await expect(inbox).toHaveCount(0);
        await page.keyboard.press("ControlOrMeta+Shift+d");
        await expect(inbox).toBeFocused();
      });

      await test.step("settling the selected chat lands in its successor", async () => {
        const title = "Finished focus check";
        // Settle is offered for a conversation, while the successor can still be a draft.
        const finished = await seed.createRelatedChat({
          projectId: manifest.projectId,
          noThreadFallbackTitle: title,
          relatedPageIds: [],
          thread: {
            threadId: createUuidV7(),
            threadName: title,
            threadPreview: "",
            statusType: "idle",
            statusActiveFlags: [],
            unread: false,
          },
        });
        const finishedRow = page.locator(
          `[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-title="${title}"]:visible`,
        );
        const finishedScene = page.locator(
          `[data-workbench-scene-owner="session:${finished.sessionId}"]:visible`,
        );
        await finishedRow.click();
        await expect(finishedScene).toBeVisible();
        await finishedRow.hover();
        await finishedRow.getByRole("button", { name: "Settle", exact: true }).click();
        await expect(session.locator(composer)).toBeFocused();
      });

      const sceneOnScreen = () =>
        page
          .locator('[data-workbench-scene-owner^="session:"]:visible')
          .first()
          .getAttribute("data-workbench-scene-owner");
      const titled = (title: string) =>
        page.locator(
          `[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-title="${title}"]:visible`,
        );
      for (const title of ["Flow chat one", "Flow chat two", "Flow chat three"]) {
        await seed.createRelatedChat({
          projectId: manifest.projectId,
          noThreadFallbackTitle: title,
          relatedPageIds: [],
        });
      }

      await test.step("chat shortcuts keep working from the composer they land in", async () => {
        await titled("Flow chat one").click();
        await expect(composer).toBeFocused();
        const seen = new Set([await sceneOnScreen()]);
        for (let step = 0; step < 2; step += 1) {
          const before = await sceneOnScreen();
          await page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
          await expect.poll(sceneOnScreen).not.toBe(before);
          await expect(composer).toBeFocused();
          seen.add(await sceneOnScreen());
        }
        expect(seen.size).toBe(3);
      });

      await test.step("Escape releases an empty composer and the next chat still lands", async () => {
        await page.keyboard.press("Escape");
        await expect(composer).not.toBeFocused();
        const before = await sceneOnScreen();
        await page.keyboard.press("ControlOrMeta+Alt+ArrowUp");
        await expect.poll(sceneOnScreen).not.toBe(before);
        await expect(composer).toBeFocused();
      });

      await test.step("New chat and Archive run from inside a composer", async () => {
        const before = await sceneOnScreen();
        await page.keyboard.press("ControlOrMeta+n");
        await expect.poll(sceneOnScreen).not.toBe(before);
        await expect(composer).toBeFocused();
        await page.keyboard.insertText("typed straight away");
        await expect(composer).toContainText("typed straight away");

        await titled("Flow chat two").click();
        await expect(composer).toBeFocused();
        await page.keyboard.press("ControlOrMeta+Shift+a");
        await expect(titled("Flow chat two")).toHaveCount(0);
        await expect(composer).toBeFocused();
      });
    },
  );
});
