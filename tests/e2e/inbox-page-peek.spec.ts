import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { invokeIpc } from "./support/editor-scenario";

test("opens a message's Page beside its Inbox and lists the Inbox Database in Space", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const artifacts =
    process.env.NODEX_INBOX_PEEK_ARTIFACT_DIR ?? testInfo.outputPath("inbox-page-peek-review");
  await mkdir(artifacts, { recursive: true });
  const claims: { name: string; expected: unknown; actual: unknown }[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  await withElectronScenario(
    { label: "inbox-page-peek", scenarioId: null },
    async ({ page, seed }) => {
      await invokeIpc(page, "settings:inbox:update", { suggestions: "off" });
      const project = await seed.createProject({ name: "Peek Project", sources: [] });
      const firstText = "Compare the two sync designs before Friday.";
      const secondText = "Collect the keyboard shortcuts worth keeping.";
      const projectText = "Draft the Peek Project release note.";
      const first = await seed.sendInboxMessage(firstText);
      const second = await seed.sendInboxMessage(secondText);
      const projectMessage = await seed.sendInboxMessage(projectText, {
        kind: "project",
        projectId: project.id,
      });
      await page.setViewportSize({ width: 1440, height: 860 });

      // Each tab group of the selected Scene's right stack has its own tab row in the title row.
      const groups = () => page.locator('[data-panel-tab-row^="right:"]').filter({ visible: true });
      const openPage = async (pageId: string) => {
        const row = page.locator(`[data-inbox-page-id="${pageId}"]`);
        await row.getByTestId("inbox-message-unit").hover();
        await row.getByRole("button", { name: "Message actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Open page", exact: true }).click();
      };
      const peekTab = () => groups().nth(1).getByRole("tab");

      let status: "passed" | "failed" = "failed";
      let failure: string | null = null;
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1440, height: 860 },
      });
      await page.screencast.showActions({
        position: "bottom",
        style: { title: "font-size: 14px" },
      });
      try {
        await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
        const inbox = page.locator('[data-inbox-scope="library"]');
        await expect(inbox).toBeVisible();
        const inboxPanel = page.getByTestId("inbox-right-panel");
        await expect(groups()).toHaveCount(1);
        await page.screenshot({ path: path.join(artifacts, "1-library-inbox.png") });

        // The Page opens as a preview in a new group to the Inbox's right; the stream stays.
        await openPage(first.pageId);
        await expect(groups()).toHaveCount(2);
        await expect(peekTab()).toHaveCount(1);
        await expect(peekTab()).toContainText(firstText);
        await expect(inboxPanel.getByText(firstText).first()).toBeVisible();
        claim(
          "Open page keeps the Library Inbox in view beside the Page",
          { groups: 2, inboxTabSelected: true, inboxVisible: true, space: 0 },
          {
            groups: await groups().count(),
            inboxTabSelected:
              (await groups().first().getByRole("tab", { selected: true }).textContent()) ===
              "Inbox",
            inboxVisible: await inbox.isVisible(),
            space: await page.getByTestId("library-right-panel").count(),
          },
        );
        claim(
          "The Page beside the Inbox is a preview",
          "italic",
          await peekTab()
            .locator("[data-app-shell-tab-title]")
            .evaluate((title) => getComputedStyle(title).fontStyle),
        );
        await page.screenshot({ path: path.join(artifacts, "2-page-beside-library-inbox.png") });

        // The next message's Page replaces the preview instead of adding a tab.
        await openPage(second.pageId);
        // The replaced tab animates out before the group settles on one tab.
        await expect(peekTab()).toHaveCount(1);
        await expect(peekTab()).toContainText(secondText);
        claim(
          "Opening another message's Page replaces the preview",
          { groups: 2, tabsBeside: 1 },
          {
            groups: await groups().count(),
            tabsBeside: await peekTab().count(),
          },
        );
        await page.screenshot({ path: path.join(artifacts, "3-preview-replaced.png") });

        // Closing the last tab beside the Inbox returns it to full width.
        await peekTab().hover();
        await groups()
          .nth(1)
          .getByRole("button", { name: /^Close .* tab$/ })
          .click();
        await expect(groups()).toHaveCount(1);
        claim(
          "Closing the last tab beside the Inbox returns it to full width",
          1,
          await groups().count(),
        );

        // A Project's Inbox, its Home, opens its messages' Pages the same way.
        await page.getByRole("button", { name: "Open Peek Project", exact: true }).click();
        const projectPanel = page.getByTestId("project-right-panel");
        await expect(projectPanel.locator('[data-inbox-scope="project"]')).toBeVisible();
        await openPage(projectMessage.pageId);
        await expect(groups()).toHaveCount(2);
        await expect(peekTab()).toHaveCount(1);
        await expect(peekTab()).toContainText(projectText);
        claim(
          "A Project's Inbox opens a message's Page beside itself",
          { groups: 2, inboxVisible: true },
          {
            groups: await groups().count(),
            inboxVisible: await projectPanel.locator('[data-inbox-scope="project"]').isVisible(),
          },
        );
        await page.screenshot({ path: path.join(artifacts, "4-page-beside-project-inbox.png") });

        // Space lists the Library Inbox Database with the rest of the Library's content.
        await page.getByRole("button", { name: "Space", exact: true }).click();
        const content = page.getByRole("list", { name: "Content" });
        const inboxRow = content.getByRole("listitem").filter({ hasText: /^Inbox$/ });
        await expect(inboxRow).toBeVisible();
        await inboxRow.click();
        const libraryPanel = page.getByTestId("library-right-panel");
        await expect(
          groups().first().getByRole("tab", { name: "Inbox", selected: true }),
        ).toBeVisible();
        await expect(libraryPanel.getByText(firstText).first()).toBeVisible();
        await expect(libraryPanel.getByText(secondText).first()).toBeVisible();
        claim(
          "Space opens the Inbox Database with the Library Inbox's messages",
          { firstMessage: true, secondMessage: true, projectMessage: false },
          {
            firstMessage: await libraryPanel.getByText(firstText).first().isVisible(),
            secondMessage: await libraryPanel.getByText(secondText).first().isVisible(),
            projectMessage: (await libraryPanel.getByText(projectText).count()) > 0,
          },
        );

        // Like a Project's Database, the Inbox's offers no Archive while the Inbox depends on it.
        await inboxRow.hover();
        await inboxRow.getByRole("button", { name: "Actions for Inbox", exact: true }).click();
        const menu = page.getByRole("menu");
        await expect(menu.getByRole("menuitem", { name: "Move to" })).toBeVisible();
        claim(
          "The Inbox Database's Space actions omit Archive",
          { moveTo: 1, archive: 0 },
          {
            moveTo: await menu.getByRole("menuitem", { name: "Move to" }).count(),
            archive: await menu.getByRole("menuitem", { name: "Archive" }).count(),
          },
        );
        // Let the menu finish opening before capturing it.
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(artifacts, "5-inbox-database-in-space.png") });
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
        await page.waitForTimeout(700);
        status = "passed";
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        await page.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => undefined);
        throw error;
      } finally {
        await page.screencast.stop();
        await writeFile(
          path.join(artifacts, "result.json"),
          `${JSON.stringify({ status, fixture: "fresh disposable Electron Profile; suggestions disabled; two synthetic Library Inbox messages and one Project Inbox message", claims, failure }, null, 2)}\n`,
        );
        await writeFile(
          path.join(artifacts, "README.md"),
          `# Inbox Page peek and the Inbox Database in Space\n\nStatus: **${status}**\n\nA fresh disposable Electron Profile opens a Library Inbox message's Page, which appears as a preview in a new group to the Inbox's right while the stream stays in view. Opening the next message's Page replaces that preview, and closing it returns the Inbox to full width. A Project's Inbox opens its message's Page the same way. Space then lists the Library Inbox Database with the Library's other content, opens it with the Library Inbox's messages, and its actions omit Archive because the Inbox depends on it. The recording uses synthetic content and real renderer/Main/Core operations. Exact expected and actual values are in result.json.\n\nArtifacts: review.webm, 1-library-inbox.png, 2-page-beside-library-inbox.png, 3-preview-replaced.png, 4-page-beside-project-inbox.png and 5-inbox-database-in-space.png.\n${failure ? `\nFailure: ${failure}\n` : ""}`,
        );
      }
    },
  );
});
