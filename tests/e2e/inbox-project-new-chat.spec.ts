import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { invokeIpc } from "./support/editor-scenario";

test("a chat a Project Inbox starts in a repository opens at once and runs in its Page's checkout", async () => {
  test.setTimeout(180_000);
  await withElectronScenario(
    { label: "inbox-project-new-chat", scenarioId: null },
    async ({ page, seed, profile }) => {
      await invokeIpc(page, "settings:inbox:update", {
        suggestions: "off",
        showPageBesideNewChats: false,
      });
      const repository = path.join(profile.projectsDirectory, "inbox-repository");
      mkdirSync(repository, { recursive: true });
      writeFileSync(path.join(repository, "README.md"), "Inbox chat fixture\n");
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repository });
      git("init", "--initial-branch=main");
      git("config", "user.email", "inbox-e2e@nodex.invalid");
      git("config", "user.name", "Nodex Inbox E2E");
      git("add", ".");
      git("commit", "-m", "fixture");
      const source = realpathSync(repository);

      const project = await seed.createProject({ name: "Inbox repository", sources: [source] });
      const text = "Tidy the README headings.";
      const { pageId } = await seed.sendInboxMessage(text, {
        kind: "project",
        projectId: project.id,
      });
      await page.setViewportSize({ width: 1440, height: 860 });
      await page.locator('[data-app-action-sidebar-project-label="Inbox repository"]').click();

      const row = page
        .locator('[data-inbox-scope="project"]:visible')
        .locator(`[data-inbox-page-id="${pageId}"]`);
      await row.getByTestId("inbox-message-unit").hover();
      await row.getByRole("button", { name: "Handle manually", exact: true }).click();
      await row.getByRole("button", { name: "Start chat", exact: true }).click();
      // Open the chat the moment Core links it, while its launch may still be admitting.
      await row.getByRole("button", { name: "Open chat", exact: true }).click();
      await expect(
        page
          .locator('[data-app-action-sidebar-thread-row][aria-current="page"]')
          .filter({ hasText: text }),
      ).toHaveCount(1);

      const session = async () =>
        (await invokeIpc(page, "workspace:tasks:list", project.id)).items.find(
          (candidate) => candidate.executionRef,
        );
      await expect.poll(async () => (await session())?.executionRef ?? null).not.toBeNull();
      const sessionId = (await session())!.id;
      // The conversation is there from the start: reading it never fails while Git works.
      const read = () => invokeIpc(page, "agent-runtime:session:read", { sessionId });
      await read();
      // The Inbox prompt is projected after the Thread is readable.
      await expect
        .poll(async () =>
          (await read()).snapshot.projection.messages.some((message) =>
            message.text.includes(text),
          ),
        )
        .toBe(true);
      // Its first Run starts only in the Page's own checkout, on the Page's branch.
      const inspect = async () =>
        (await invokeIpc(page, "agent-runtime:session:inspect", { sessionId })).thread;
      await expect
        .poll(async () => (await inspect()).branch ?? "", { timeout: 60_000 })
        .toMatch(/tidy-the-readme-headings$/);
      const thread = await inspect();
      expect(thread.worktreePath).toBeTruthy();
      expect(path.relative(source, thread.worktreePath!).startsWith("..")).toBe(true);
      expect(
        execFileSync("git", ["branch", "--show-current"], {
          cwd: thread.worktreePath!,
          encoding: "utf8",
        }).trim(),
      ).toBe(thread.branch);
      // The Run was released from preparation and started; a failed preparation never starts.
      await expect
        .poll(async () => (await read()).snapshot.projection.runs[0]?.startedAt ?? null, {
          timeout: 60_000,
        })
        .not.toBeNull();
      await expect(page.getByText("Thread could not be restored", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Couldn’t prepare the worktree", { exact: true })).toHaveCount(0);
    },
  );
});
