import { expect, test, type Page } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { invokeIpc } from "./support/editor-scenario";

const MESSAGE_COUNT = 14;

const stream = (page: Page) =>
  page.locator('[data-inbox-scope="project"]:visible [data-testid="inbox-stream"]');
const message = (page: Page, text: string) =>
  stream(page).getByTestId("inbox-message").filter({ hasText: text });
/** How far a message sits below the top of the stream's viewport. */
const offsetOf = (page: Page, text: string) =>
  message(page, text).evaluate((element) => {
    const scroller = element.closest('[data-testid="inbox-stream"]')!;
    return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });

test("keeps a Project Inbox current with its message Pages and keeps the reader's place", async () => {
  test.setTimeout(180_000);
  await withElectronScenario({ label: "inbox-sync", scenarioId: null }, async ({ page, seed }) => {
    await invokeIpc(page, "settings:inbox:update", { suggestions: "off" });
    const project = await seed.createProject({ name: "Inbox sync", sources: [] });
    for (let index = 1; index <= MESSAGE_COUNT; index += 1) {
      await seed.sendInboxMessage(`Message ${index} for later`, {
        kind: "project",
        projectId: project.id,
      });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('[data-app-action-sidebar-project-label="Inbox sync"]').click();
    await expect(stream(page).getByTestId("inbox-message")).toHaveCount(MESSAGE_COUNT);

    // An edit made in the message's Page, not in the Inbox, reaches the Inbox on its own.
    const pageId = await message(page, "Message 14 for later").getAttribute("data-inbox-page-id");
    expect(pageId).toBeTruthy();
    await seed.replaceOwnedDocument({
      projectId: project.id,
      pageId: pageId!,
      markdown: "Message 14 rewritten in its Page",
      operationId: createUuidV7(),
      mutationId: createUuidV7(),
      clientSessionId: "inbox-sync",
    });
    await expect(message(page, "Message 14 rewritten in its Page")).toBeVisible();

    // Reading an earlier message, leaving for the Board, and coming back lands on it again.
    await message(page, "Message 3 for later").evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await expect.poll(() => offsetOf(page, "Message 3 for later")).toBeLessThan(40);
    const offset = await offsetOf(page, "Message 3 for later");
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Open Board" }).click();
    await expect(page.locator('[data-inbox-scope="project"]:visible')).toHaveCount(0);
    await page.getByRole("tab", { name: "Inbox", exact: true }).click();
    await expect(stream(page).getByTestId("inbox-message")).toHaveCount(MESSAGE_COUNT);
    await expect
      .poll(async () => Math.abs((await offsetOf(page, "Message 3 for later")) - offset))
      .toBeLessThanOrEqual(2);
  });
});
