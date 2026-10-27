import { expect, test, type Page } from "@playwright/test";
import { appendFile, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { createAgentSmokeDraft, sendAgentPrompt } from "./support/agent-smoke-harness";

const prompt = "Review the local media layout";

test("renders mixed local media with valid HTML and preserves its controls through completion", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "thread-media-layout",
    codex: "empty",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_COMMAND_PATH: ".fake-codex/commands.jsonl",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_BASE_FIXTURE: path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "120",
      NODEX_FAKE_CODEX_CONTROLLED_PROMPT: prompt,
      NODEX_FAKE_CODEX_APP_SERVER_VERSION: "0.162.0-alpha.17.2",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-transcript-performance-app-server.mjs"),
    "0.162.0-alpha.17.2",
  );
  const directory = path.join(harness.profile.runRoot, ".fake-codex");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "state.json"),
    JSON.stringify({
      thread: null,
      turns: [],
      turnSequence: 0,
      queueSequence: 0,
      queuedSubmissions: [],
    }),
  );
  const command = (value: { type: "start" | "complete" } | { type: "delta"; delta: string }) =>
    appendFile(path.join(directory, "commands.jsonl"), `${JSON.stringify(value)}\n`);
  let page: Page | undefined;
  const nestingWarnings: string[] = [];
  try {
    page = await harness.launch();
    await page.setViewportSize({ width: 1280, height: 900 });
    page.on("console", (message) => {
      if (
        /cannot.*(?:descendant|nested|contain)|hydration error|validateDOMNesting/iu.test(
          message.text(),
        )
      )
        nestingWarnings.push(message.text());
    });
    const imagePath = path.join(harness.profile.initialProjectsDirectory, "layout-image.png");
    const secondImagePath = path.join(
      harness.profile.initialProjectsDirectory,
      "layout-second-image.png",
    );
    const videoPath = path.join(harness.profile.initialProjectsDirectory, "layout-clip.webm");
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 400;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The synthetic image encoder is unavailable");
      context.fillStyle = "#334455";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png").split(",")[1]!;
    });
    await writeFile(imagePath, Buffer.from(png, "base64"));
    await copyFile(imagePath, secondImagePath);
    await copyFile(path.resolve("tests/fixtures/workspace-media/vp8-vorbis.webm"), videoPath);
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      "Media layout review",
    );
    await sendAgentPrompt(page, draft.projectSessionId, prompt);
    await command({ type: "start" });
    await command({
      type: "delta",
      delta: [
        "\n\nOrdinary paragraph.",
        `![Wide image](<${imagePath}>)`,
        "## Gallery",
        `![Gallery one](<${imagePath}>)`,
        `![Gallery two](<${secondImagePath}>)`,
        "## Video",
        `[**Before video *![Review clip](<${videoPath}>)* after video**](https://example.test/review)`,
        `Inline image ![Inline thumbnail](<${imagePath}>) stays beside its text.\n\n`,
      ].join("\n\n"),
    });
    const body = page.locator(
      `[data-workbench-scene-owner="session:${draft.projectSessionId}"] [data-local-conversation-thread-body="true"]`,
    );
    const wideImage = body.getByRole("img", { name: "Wide image", exact: true });
    const firstImage = body.getByRole("img", { name: "Gallery one", exact: true });
    const secondImage = body.getByRole("img", { name: "Gallery two", exact: true });
    const inlineImage = body.getByRole("img", { name: "Inline thumbnail", exact: true });
    for (const image of [wideImage, firstImage, secondImage, inlineImage]) {
      await expect(image).toBeAttached();
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBe(640);
    }
    const video = body.locator('video[aria-label="Review clip"]');
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.duration))
      .toBeGreaterThan(0.5);

    const geometry = await body.evaluate((element) => {
      const image = (alt: string) => element.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)!;
      const wide = image("Wide image");
      const first = image("Gallery one");
      const second = image("Gallery two");
      const inline = image("Inline thumbnail");
      const video = element.querySelector("video")!;
      const gallery = first.closest("[data-markdown-image-grid]");
      return {
        ordinaryParagraph: Array.from(element.querySelectorAll("p")).some(
          (paragraph) => paragraph.textContent === "Ordinary paragraph.",
        ),
        invalidParagraphDescendants: element.querySelectorAll("p div, p p").length,
        sliderInsideSpan: element.querySelectorAll("span > [data-slot='slider']").length,
        videoInsideParagraph: video.closest("p") !== null,
        videoInsidePhrasingWrapper: video.closest("strong, em, del, a") !== null,
        controlsInsideLink: element.querySelectorAll("a button, a input, a video").length,
        wideImage: wide.closest("[data-wide-markdown-block-kind='image']") !== null,
        groupedImages: gallery !== null && gallery === second.closest("[data-markdown-image-grid]"),
        galleryTopDelta: Math.abs(
          first.getBoundingClientRect().top - second.getBoundingClientRect().top,
        ),
        inlineImageWidened:
          inline.closest("[data-wide-markdown-block], [data-markdown-image-grid]") !== null,
        wideWidth: wide.getBoundingClientRect().width,
        inlineWidth: inline.getBoundingClientRect().width,
        videoWidth: video.getBoundingClientRect().width,
        videoContainerWidth: video.parentElement!.getBoundingClientRect().width,
      };
    });
    expect(geometry).toMatchObject({
      ordinaryParagraph: true,
      invalidParagraphDescendants: 0,
      sliderInsideSpan: 0,
      videoInsideParagraph: false,
      videoInsidePhrasingWrapper: false,
      controlsInsideLink: 0,
      wideImage: true,
      groupedImages: true,
      inlineImageWidened: false,
    });
    expect(geometry.galleryTopDelta).toBeLessThanOrEqual(1);
    expect(geometry.wideWidth).toBeGreaterThan(geometry.inlineWidth + 10);
    expect(geometry.videoWidth).toBeGreaterThan(100);
    expect(geometry.videoWidth).toBeLessThanOrEqual(geometry.videoContainerWidth + 1);
    const before = body.getByText("Before video", { exact: true });
    const after = body.getByText("after video", { exact: true });
    await expect(body.getByRole("link", { name: "Before video", exact: true })).toHaveAttribute(
      "href",
      "https://example.test/review",
    );
    await expect(body.getByRole("link", { name: "after video", exact: true })).toHaveAttribute(
      "href",
      "https://example.test/review",
    );
    const videoNode = await video.elementHandle();
    if (!videoNode) throw new Error("The native video did not mount");
    expect(
      await before.evaluate(
        (element, video) =>
          Boolean(element.compareDocumentPosition(video) & Node.DOCUMENT_POSITION_FOLLOWING),
        videoNode,
      ),
    ).toBe(true);
    expect(
      await after.evaluate(
        (element, video) =>
          Boolean(video.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
        videoNode,
      ),
    ).toBe(true);
    await body.getByRole("button", { name: "Play video", exact: true }).click();
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(false);
    await body.getByRole("button", { name: "Pause video", exact: true }).click();
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(true);
    const time = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
    await body.getByRole("slider", { name: "Seek in video", exact: true }).press("ArrowRight");
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeGreaterThan(time + 0.05);
    await body.getByRole("button", { name: "Video volume", exact: true }).click();
    await page.getByRole("slider", { name: "Video volume", exact: true }).press("ArrowLeft");
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.volume))
      .toBeLessThan(1);
    await page.keyboard.press("Escape");
    await command({ type: "complete" });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    expect(await video.evaluate((element, original) => element === original, videoNode)).toBe(true);
    await expect(video).toBeVisible();
    expect(nestingWarnings).toEqual([]);
    await testInfo.attach("media-layout", {
      body: JSON.stringify({ geometry, nestingWarnings }),
      contentType: "application/json",
    });
    await testInfo.attach("media-layout-final", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await videoNode.dispose();
  } catch (error) {
    await testInfo.attach("runtime-logs", {
      body: await readBoundedElectronRuntimeLogs(harness.profile, 300_000),
      contentType: "text/plain",
    });
    if (page && !page.isClosed())
      await testInfo.attach("media-layout-failure", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    throw error;
  } finally {
    await harness.close();
  }
});
