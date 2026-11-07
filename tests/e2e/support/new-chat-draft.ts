import { expect, type Locator, type Page } from "@playwright/test";

/** Durable creation precedes navigation. Input must target the new Session's rendered Scene. */
export async function waitForDraftScene(page: Page, sessionId: string): Promise<Locator> {
  const scene = page.locator(`[data-workbench-scene-owner="session:${sessionId}"]`);
  await expect(scene).toBeVisible();
  return scene;
}

/** Opens the first Project's New Chat. The sidebar's own New chat follows whichever is active. */
export async function openNewChatDraft(page: Page): Promise<Locator> {
  const project = await page.evaluate(async () => {
    const projects = (await window.api?.invoke("projects:list")) as
      | { items: Array<{ name: string }> }
      | undefined;
    return projects?.items[0]?.name ?? null;
  });
  if (!project) throw new Error("The Profile has no Project to start a chat in");
  await page.getByRole("button", { name: `Start new chat in ${project}`, exact: true }).click();
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
          })) as
            | { items: Array<{ id: string; thread?: unknown; executionRef?: unknown }> }
            | undefined;
          // A draft has neither a native Thread nor an Agent execution binding.
          const drafts = tasks?.items.filter(
            (task) => task.thread == null && task.executionRef == null,
          );
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
