import { expect, test, type Page, type Locator } from "@playwright/test";
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

test("sends text and Library images through text and Block menus to new and existing chats", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const prompt = "Explain this selected paragraph";
  const reply = "Selected paragraph received";
  await withScriptedModelServer(
    {
      exchanges: [
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
          `${prompt}\n<image source="${imageSource}">Diagram</image>\nEnd selection`,
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
        await page.getByRole("button", { name: "Open Send Blocks", exact: true }).click();
        await openBoardPageFromCard({
          page,
          card: page.locator(`[data-board-uuid-v7="${source.pageId}"]`),
          tabName: "Send source",
        });
        await selectPrompt(page, paragraphs, prompt);
        await paragraphs.first().hover();
        await page.locator('.bn-side-menu button[draggable="true"]').click();
        const sideMenu = page.getByRole("dialog", { name: "Block actions", exact: true });
        await sideMenu.getByRole("option", { name: "Send to chat", exact: true }).click();
        const destination = page.getByRole("dialog", { name: "Send to chat", exact: true });
        await expect(destination.getByRole("button", { name: "Send", exact: true })).toBeVisible();
        await destination.getByRole("button", { name: "Send & wrap" }).click();
        await page.screenshot({ path: testInfo.outputPath("send-to-chat-side-menu.png") });
        await destination.locator('[data-nfm-send-to-thread-row-kind="thread"]').click();
        await expect(page.getByText("Sent to chat", { exact: true })).toBeVisible();
        await expect(sideMenu).toHaveCount(0);
        await expect(editor.locator('[data-content-type="toggleListItem"]')).not.toHaveCount(0);
        await relatedChat.locator("button").first().click();
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
        await page
          .locator(
            `[data-app-action-sidebar-thread-id]:not([data-app-action-sidebar-thread-id="${firstThreadId}"])`,
          )
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
