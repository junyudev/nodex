import { expect, type Locator, type Page } from "@playwright/test";

/** Durable creation precedes navigation. Input must target the new Session's rendered Scene. */
export async function waitForDraftScene(page: Page, sessionId: string): Promise<Locator> {
  const scene = page.locator(`[data-workbench-scene-owner="session:${sessionId}"]`);
  await expect(scene).toBeVisible();
  return scene;
}

export async function openNewChatDraft(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "New chat" }).first().click();
  let sessionId: string | null = null;
  await expect
    .poll(
      async () => {
        sessionId = await page.evaluate(async () => {
          const projects = (await window.api?.invoke("projects:list")) as
            | { items: Array<{ id: string }> }
            | undefined;
          const projectId = projects?.items[0]?.id;
          if (!projectId) return null;
          const tasks = (await window.api?.invoke("workspace:tasks:list", projectId, {
            first: 50,
          })) as { items: Array<{ id: string; thread?: unknown }> } | undefined;
          const drafts = tasks?.items.filter((task) => task.thread == null);
          return drafts?.length === 1 ? drafts[0]!.id : null;
        });
        return sessionId;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  if (!sessionId) throw new Error("New chat did not create one draft Session");
  return waitForDraftScene(page, sessionId);
}
