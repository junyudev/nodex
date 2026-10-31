import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { openProjectBoard } from "../../scripts/scenarios/harness/project-board-ui";
import {
  responses,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import { readTestClipboard, writeTestClipboardImage } from "./clipboard";
import { collectRecords, setAgentExecutionProfile } from "./support/agent-smoke-harness";
import { createConvergenceBoardPage, createConvergenceProject } from "./support/editor-scenario";
import { openBoardPageFromCard } from "./support/open-board-page";

const PAGE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAAAZElEQVR4nO3QMQ0AIADAMIQhBPlIwQGc7GgyAUvHXlOXxveDeIAAAQIEKBwgQIAAAQoHCBAgQIDCAQIECBCgcIAAAQIEKBwgQIAAAQoHCBAgQIDCAQIECBCgcIAAAQIEKBygRwcHXymHtEsoygAAAABJRU5ErkJggg==";
// A different size from the Page image makes preview navigation observable.
const WRITTEN_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMAAAABgCAIAAADEouq+AAABBklEQVR4nO3SQQkAIADAQMMaxzgGtIN7iHBwAfbYmGvDtfG8gK8ZiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEcgBRsybr72+iHwAAAABJRU5ErkJggg==",
  "base64",
);

async function expectImageSize(image: Locator, width: number, height: number): Promise<void> {
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) =>
        element.complete ? [element.naturalWidth, element.naturalHeight] : null,
      ),
    )
    .toEqual([width, height]);
}

test("Page image paste and written images reach the Agent and share the sent message viewer", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const artifacts = "/Users/asc/repo/nodex/notes.local/artifacts/chat-message-images/e2e";
  fs.mkdirSync(artifacts, { recursive: true });
  const prompt = "Inspect both images";
  const reply = "Both images received";
  let writtenImagePath = "";

  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "attached and written images",
          expectedCalls: 1,
          maximumCalls: 1,
          match: (request) => request.hasUserInputText(prompt),
          respond: (request) => {
            const records = collectRecords(request.body.input);
            const images = records.filter((item) => item.type === "input_image");
            expect(images).toHaveLength(2);
            for (const image of images) {
              expect(image.image_url).toEqual(expect.stringMatching(/^data:image\/png;base64,/u));
            }
            const text = records
              .filter((item) => item.type === "input_text")
              .map((item) => item.text)
              .join("\n");
            expect(text).toContain(`[Image #2] (caption: shot; path: ${writtenImagePath})`);
            expect(text).not.toContain("![shot]");
            expect(text).not.toContain("nodex://files/");
            return responses.stream([
              responses.created("chat_images_response"),
              responses.assistantMessage("chat_images_message", reply, "final_answer"),
              responses.completed("chat_images_response", true),
            ]);
          },
        },
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "chat-message-images",
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
      writtenImagePath = path.join(harness.profile.runRoot, "shot.png");
      fs.writeFileSync(writtenImagePath, WRITTEN_IMAGE);
      let tracing = false;
      try {
        const page = await harness.launch();
        await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
        tracing = true;
        await harness.application.evaluate(({ BrowserWindow, nativeTheme }) => {
          nativeTheme.themeSource = "light";
          BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
        });
        await page.emulateMedia({ colorScheme: "light" });
        const project = await createConvergenceProject(
          page,
          "Image messages",
          harness.profile.runRoot,
        );
        const source = await createConvergenceBoardPage(
          page,
          project,
          "Image source",
          "Page image for chat",
        );
        await page.getByRole("button", { name: "Open Image messages", exact: true }).click();
        await openProjectBoard(page);
        await openBoardPageFromCard({
          page,
          card: page.locator(`[data-board-uuid-v7="${source.pageId}"]`),
          tabName: "Image source",
        });
        const editor = page.locator(
          `[data-page-stage-page-id="${source.pageId}"]:visible .ProseMirror[contenteditable="true"]`,
        );
        await editor.getByText("Page image for chat", { exact: true }).click();
        await page.keyboard.press("Meta+ArrowRight");
        await page.keyboard.press("Enter");
        await writeTestClipboardImage(harness.application, PAGE_IMAGE);
        await page.keyboard.press("Meta+v");
        const imageBlock = editor.locator(
          '[data-content-type="image"][data-url^="nodex://files/"]',
        );
        await expectImageSize(imageBlock.locator("img"), 96, 48);
        const libraryImageUrl = await imageBlock.getAttribute("data-url");
        if (!libraryImageUrl) throw new Error("The pasted Page image has no Library File URL");
        await page.screenshot({ path: path.join(artifacts, "01-page-image.png"), fullPage: true });

        await imageBlock.click();
        await page.keyboard.press("Meta+c");
        await expect
          .poll(async () => (await readTestClipboard(harness.application)).html)
          .toContain(libraryImageUrl);
        await page
          .getByRole("button", { name: "Start new chat in Image messages", exact: true })
          .click();
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
        await composer.click();
        await page.keyboard.press("Meta+v");
        const attachment = page.locator("[data-composer-image-attachment-id]");
        await expect(attachment).toHaveCount(1);
        await expectImageSize(attachment.locator("img"), 96, 48);
        await expect(composer).toHaveText("");
        const writtenPrompt = `${prompt}\n![shot](${writtenImagePath})`;
        await composer.fill(writtenPrompt);
        await expect(composer).toHaveText(writtenPrompt, { useInnerText: true });
        await page.screenshot({
          path: path.join(artifacts, "02-composer-after-paste.png"),
          fullPage: true,
        });

        await page.getByRole("button", { name: "Send prompt", exact: true }).click();
        await expect(page.getByText(reply, { exact: true }).last()).toBeVisible({
          timeout: 30_000,
        });
        const bubble = page
          .locator('[data-user-message-bubble="true"]')
          .filter({ hasText: prompt });
        await expect(bubble).toHaveCount(1);
        const strip = page.locator('[data-user-attachment-strip="true"]');
        await expect(strip).toHaveCount(1);
        const attachedThumbnail = strip
          .getByRole("button", { name: "Open image preview", exact: true })
          .first()
          .locator("img");
        await expectImageSize(attachedThumbnail, 96, 48);
        const stripBounds = await strip.boundingBox();
        const bubbleBounds = await bubble.boundingBox();
        if (!stripBounds || !bubbleBounds) throw new Error("Sent message has no visible geometry");
        expect(stripBounds.y + stripBounds.height).toBeLessThanOrEqual(bubbleBounds.y);
        const reference = bubble.getByRole("button", { name: "Open Image #2", exact: true });
        await expectImageSize(reference.locator("img"), 192, 96);
        await expect(bubble).not.toContainText("![shot]");
        await expect(bubble).not.toContainText("nodex://files/");
        await page.screenshot({ path: path.join(artifacts, "03-sent-bubble.png"), fullPage: true });

        await reference.click();
        const preview = page.getByRole("dialog", { name: "Image preview", exact: true });
        await expect(preview).toBeVisible();
        await expectImageSize(preview.locator("img"), 192, 96);
        await page.screenshot({ path: path.join(artifacts, "04-viewer.png"), fullPage: true });
        await preview.getByRole("button", { name: "Previous image", exact: true }).click();
        await expectImageSize(preview.locator("img"), 96, 48);
      } catch (error) {
        await testInfo.attach("runtime-logs", {
          body: await readBoundedElectronRuntimeLogs(harness.profile),
          contentType: "text/plain",
        });
        await harness.page.screenshot({ path: testInfo.outputPath("failure.png"), fullPage: true });
        throw error;
      } finally {
        try {
          if (tracing) {
            const tracePath = testInfo.outputPath("trace.zip");
            await harness.page.context().tracing.stop({ path: tracePath });
            await testInfo.attach("trace", { path: tracePath, contentType: "application/zip" });
          }
        } finally {
          await harness.close();
        }
      }
    },
  );
});
