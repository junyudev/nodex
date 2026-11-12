import { expect, test, type Page, type Locator } from "@playwright/test";
import { openProjectBoard } from "../../scripts/scenarios/harness/project-board-ui";
import fs from "node:fs";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  createConvergenceProject,
  createConvergenceBoardPage,
  seedConvergenceDocument,
} from "./support/editor-scenario";
import { collectRecords } from "./support/agent-smoke-harness";
import { writeTestClipboardImage } from "./clipboard";
import { openBoardPageFromCard } from "./support/open-board-page";

test("sends text, Library images, and Prompts to new and existing chats", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const prompt = "Explain this selected paragraph";
  const reply = "Selected paragraph received";
  const promptBlockText = "Summarize the release plan in one line";
  const promptBlockReply = "Prompt block received";
  const besideDraft = "Draft written beside the chat";
  const besideReply = "Beside draft received";
  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "beside draft",
          expectedCalls: 1,
          maximumCalls: 1,
          match: (request) => request.hasInputText(besideDraft),
          respond: () =>
            responses.stream([
              responses.created("beside_draft_response"),
              responses.assistantMessage("beside_draft_message", besideReply, "final_answer"),
              responses.completed("beside_draft_response", true),
            ]),
        },
        {
          name: "prompt block",
          expectedCalls: 1,
          maximumCalls: 1,
          match: (request) => request.hasInputText(promptBlockText),
          respond: () =>
            responses.stream([
              responses.created("prompt_block_response"),
              responses.assistantMessage("prompt_block_message", promptBlockReply, "final_answer"),
              responses.completed("prompt_block_response", true),
            ]),
        },
        {
          name: "page blocks",
          expectedCalls: 3,
          maximumCalls: 3,
          match: (request) => request.hasInputText(prompt),
          respond: (request, index) => {
            const images = collectRecords(request.body.input).filter(
              (item) => item.type === "input_image",
            );
            expect(images.length).toBeGreaterThan(0);
            expect(
              images.every(
                (item) =>
                  typeof item.image_url === "string" &&
                  item.image_url.startsWith("data:image/png;base64,"),
              ),
            ).toBe(true);
            return responses.stream([
              responses.created(`page_response_${index}`),
              responses.assistantMessage(
                `page_message_${index}`,
                `${reply} ${index}`,
                "final_answer",
              ),
              responses.completed(`page_response_${index}`, true),
            ]);
          },
        },
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "nfm-send-to-chat",
        cwd: process.cwd(),
        codexApiKey: "nodex-scripted-model-test-key",
        prepareAgentRuntime: false,
        environment: {
          NODEX_LOG_FILE: "1",
          NODEX_LOG_FILE_LEVEL: "debug",
          ...modelServer.loopbackEnvironment(),
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
        },
      });
      fs.writeFileSync(
        path.join(harness.profile.codexHome, "config.toml"),
        `model_provider = "openai"
openai_base_url = "${modelServer.baseUrl}/v1"
request_max_retries = 0
stream_max_retries = 0
[features]
respect_system_proxy = false
`,
        { mode: 0o600 },
      );
      try {
        const page = await harness.launch();
        const project = await createConvergenceProject(
          page,
          "Send Blocks",
          harness.profile.runRoot,
        );
        const source = await createConvergenceBoardPage(page, project, "Send source", prompt);
        await page.getByRole("button", { name: "Open Send Blocks", exact: true }).click();
        await openProjectBoard(page);
        await openBoardPageFromCard({
          page,
          card: page.locator(`[data-board-uuid-v7="${source.pageId}"]`),
          tabName: "Send source",
        });
        const editor = page.locator(
          `[data-page-stage-page-id="${source.pageId}"]:visible .ProseMirror[contenteditable="true"]`,
        );
        await editor.getByText(prompt, { exact: true }).click();
        await page.keyboard.press("Meta+ArrowRight");
        await page.keyboard.press("Enter");
        await writeTestClipboardImage(
          harness.application,
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        );
        await page.keyboard.press("Meta+v");
        await expect(
          editor.locator('[data-content-type="image"][data-url^="nodex://files/"] img'),
        ).toBeVisible();
        const imageSource = await editor
          .locator('[data-content-type="image"][data-url]')
          .getAttribute("data-url");
        await seedConvergenceDocument(
          page,
          project,
          source,
          `${prompt}\n\n![Diagram](${imageSource})\n\nEnd selection`,
        );
        const paragraphs = editor.locator('[data-content-type="paragraph"] .bn-inline-content');
        await expect(paragraphs.first()).toHaveText(prompt);
        await expect(paragraphs.last()).toHaveText("End selection");
        await selectPrompt(page, paragraphs, prompt);
        await page.getByRole("button", { name: "Send to chat", exact: true }).click();
        await page.locator('[data-nfm-send-to-thread-row-kind="new-thread"]').click();
        await expect(page.getByText("Sent to new chat", { exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await page.keyboard.press("Escape");
        await page.keyboard.press("ArrowRight");
        const relatedChat = page.locator('[data-page-stage-related-chat-chip="true"]').last();
        await relatedChat.locator("button").first().click();
        await expect(
          page.locator("[data-user-message-bubble='true']").filter({ hasText: prompt }),
        ).toHaveCount(1);
        await expect(page.getByText(`${reply} 0`, { exact: true }).last()).toBeVisible({
          timeout: 30_000,
        });
        await test.step("sends a draft from a Page beside the chat in one step", async () => {
          const scene = page.locator('[data-workbench-scene-owner^="session:"]:visible');
          await page.getByRole("button", { name: "New tab", exact: true }).first().click();
          await scene
            .locator("[data-new-tab-scroll-root]")
            .getByRole("button", { name: "New page", exact: true })
            .click();
          const title = scene.getByRole("textbox", { name: "Page title", exact: true });
          await expect(title).toBeFocused();
          await page.keyboard.type("Draft");
          // Enter continues from the title onto the body's first line.
          await page.keyboard.press("Enter");
          await page.keyboard.type(besideDraft);
          const body = scene.locator(
            '[data-page-stage-page-id]:visible .ProseMirror[contenteditable="true"]',
          );
          const draft = body.getByText(besideDraft, { exact: true });
          await draft.click({ clickCount: 3 });
          // Beside a chat there is nothing to choose: Send goes to that chat.
          await page.getByRole("button", { name: "Send to chat", exact: true }).click();
          await expect(page.getByText("Sent to chat", { exact: true })).toBeVisible();
          await expect(
            page.locator("[data-user-message-bubble='true']").filter({ hasText: besideDraft }),
          ).toHaveCount(1);
          await expect(page.getByText(besideReply, { exact: true }).last()).toBeVisible({
            timeout: 30_000,
          });
          await page.screenshot({ path: testInfo.outputPath("send-to-chat-beside.png") });

          await draft.click({ clickCount: 3 });
          await page.getByRole("button", { name: "Add to composer", exact: true }).click();
          const composer = page.locator(
            '[data-codex-composer="true"][aria-label="Ask for follow-up changes"]:visible',
          );
          await expect(composer).toContainText(besideDraft);
          await expect(composer).toBeFocused();
          await page.keyboard.press("Meta+A");
          await page.keyboard.press("Backspace");
        });
        await page.getByRole("button", { name: "Open Send Blocks", exact: true }).click();
        await openProjectBoard(page);
        await openBoardPageFromCard({
          page,
          card: page.locator(`[data-board-uuid-v7="${source.pageId}"]`),
          tabName: "Send source",
        });
        await selectPrompt(page, paragraphs, prompt);
        await paragraphs.first().hover();
        await page.locator('.bn-side-menu button[draggable="true"]').click();
        const sideMenu = page.getByRole("dialog", { name: "Block actions", exact: true });
        // Outside a chat's Scene there is no chat beside the Page, so Send to chat is a picker.
        await sideMenu.getByRole("option", { name: "Send to chat", exact: true }).click();
        const destination = page.getByRole("dialog", { name: "Send to chat", exact: true });
        await expect(destination.getByRole("combobox", { name: "Search chats" })).toBeVisible();
        await expect(destination.getByRole("button", { name: "Send & wrap" })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("send-to-chat-side-menu.png") });
        await destination.locator('[data-nfm-send-to-thread-row-kind="thread"]').click();
        await expect(page.getByText("Sent to chat", { exact: true })).toBeVisible();
        await expect(sideMenu).toHaveCount(0);
        await page.locator("[data-app-action-sidebar-thread-id]").first().click();
        await expect(
          page.locator("[data-user-message-bubble='true']").filter({ hasText: prompt }),
        ).toHaveCount(2);
        await expect(page.getByText(`${reply} 1`, { exact: true }).last()).toBeVisible({
          timeout: 30_000,
        });
        await expect(page.getByText("Message could not be sent.", { exact: true })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("send-to-chat-delivered.png") });
        const firstThreadId = await page
          .locator("[data-app-action-sidebar-thread-id]")
          .first()
          .getAttribute("data-app-action-sidebar-thread-id");
        if (!firstThreadId) throw new Error("Submitted Chat identity is unavailable");
        await page.getByRole("button", { name: "Open Send Blocks", exact: true }).click();
        await openProjectBoard(page);
        const card = page.locator(`[data-board-uuid-v7="${source.pageId}"]:visible`);
        await card
          .locator('button[data-card-context-menu-trigger="true"]')
          .click({ button: "right" });
        await page.getByRole("menuitem", { name: "Open in", exact: true }).hover();
        await page.getByRole("menuitem", { name: "Send to chat…", exact: true }).click();
        await page.locator('[data-nfm-send-to-thread-row-kind="new-thread"]').click();
        await expect(page.getByText("Sent Page to new chat", { exact: true })).toBeVisible({
          timeout: 30_000,
        });
        // The scenario harness also leaves a blank "New chat" in My Project; the chat this send
        // started is the other one, titled from its prompt.
        await page
          .locator(
            `[data-app-action-sidebar-thread-id]:not([data-app-action-sidebar-thread-id="${firstThreadId}"])`,
          )
          .filter({ hasNotText: /^New chat$/u })
          .click();
        await expect(page.getByText(`${reply} 2`, { exact: true }).last()).toBeVisible({
          timeout: 30_000,
        });
        await expect(
          page
            .locator("[data-user-message-bubble='true']")
            .filter({ hasText: "Page: Send source" }),
        ).toHaveCount(1);
        const reopened = await harness.restart();
        await expect(reopened.getByText(`${reply} 2`, { exact: true }).last()).toBeVisible({
          timeout: 30_000,
        });
        await expect(
          reopened
            .locator("[data-user-message-bubble='true']")
            .filter({ hasText: "Page: Send source" }),
        ).toHaveCount(1);
        await reopened.getByRole("button", { name: "Open Send Blocks", exact: true }).click();
        await openProjectBoard(reopened);
        await openBoardPageFromCard({
          page: reopened,
          card: reopened.locator(`[data-board-uuid-v7="${source.pageId}"]`),
          tabName: "Send source",
        });
        const reopenedEditor = reopened.locator(
          `[data-page-stage-page-id="${source.pageId}"]:visible .ProseMirror[contenteditable="true"]`,
        );
        await reopenedEditor
          .locator('[data-content-type="paragraph"] .bn-inline-content')
          .last()
          .click();
        await reopened.keyboard.press("End");
        await reopened.keyboard.press("Enter");
        await reopened.keyboard.type("/prompt");
        await reopened
          .getByRole("option", { name: /^Prompt/ })
          .first()
          .click();
        await reopened.keyboard.type(promptBlockText);
        const promptBlock = reopenedEditor.locator('[data-content-type="prompt"]').last();
        await expect(promptBlock).toContainText(promptBlockText);
        // Activating a Prompt sends it, as activating a to-do checks it.
        await reopened.keyboard.press("Meta+Enter");
        await expect(promptBlock.locator("[data-nfm-prompt-status]")).toBeVisible({
          timeout: 30_000,
        });
        // The Prompt follows its own Turn, and its reply can be read and kept in the Page.
        const promptStatus = promptBlock.locator("[data-nfm-prompt-status]");
        await expect(promptStatus).toHaveText("Answered", { timeout: 30_000 });
        await reopened.screenshot({ path: testInfo.outputPath("send-to-chat-prompt-block.png") });
        await promptStatus.click();
        const replyPanel = reopened.getByRole("dialog", { name: "Prompt reply" });
        await expect(replyPanel.getByText(promptBlockReply, { exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await replyPanel.getByRole("button", { name: "Insert reply", exact: true }).click();
        // The Reply toggle opens with the reply as its children.
        const replyToggle = reopenedEditor
          .locator(".bn-block")
          .filter({
            has: reopened.locator('[data-content-type="toggleListItem"]', { hasText: "Reply" }),
          })
          .last();
        await expect(replyToggle.getByText(promptBlockReply, { exact: true })).toBeVisible();
      } catch (error) {
        await testInfo.attach("runtime-logs", {
          body: await readBoundedElectronRuntimeLogs(harness.profile),
          contentType: "text/plain",
        });
        await testInfo.attach("screen", {
          body: await harness.page.screenshot(),
          contentType: "image/png",
        });
        throw error;
      } finally {
        await harness.close();
      }
    },
  );
});

async function selectPrompt(page: Page, paragraphs: Locator, prompt: string): Promise<void> {
  const first = await paragraphs.first().boundingBox();
  const last = await paragraphs.last().boundingBox();
  if (!first || !last) throw new Error("Selection endpoints unavailable");
  await page.mouse.move(first.x + 1, first.y + first.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(last.x + last.width - 2, last.y + last.height / 2, { steps: 20 });
  } finally {
    await page.mouse.up();
  }
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain(prompt);
}
