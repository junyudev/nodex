import { expect, test } from "@playwright/test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { createAgentSmokeDraft, sendAgentPrompt } from "./support/agent-smoke-harness";

const silentWave = () => {
  const samples = 8_000;
  const bytes = Buffer.alloc(44 + samples, 128);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(samples, 24);
  bytes.writeUInt32LE(samples, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples, 40);
  return bytes;
};

test("reads message media through its native source and preserves it when streaming completes", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "conversation-media-native-source",
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
  const imagePath = path.join(harness.profile.initialProjectsDirectory, "message-image.png");
  const audioPath = path.join(harness.profile.initialProjectsDirectory, "message-audio.wav");
  await writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await writeFile(audioPath, silentWave());
  const command = (value: object) =>
    appendFile(path.join(directory, "commands.jsonl"), `${JSON.stringify(value)}\n`);
  try {
    const page = await harness.launch();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      "Message media",
    );
    await sendAgentPrompt(page, draft.projectSessionId, "Prepare a message with local media");
    await expect(page.getByText("The task completed successfully.", { exact: true })).toBeVisible();
    await command({ type: "start" });
    await command({
      type: "delta",
      delta: `\n\n![Source image](<${imagePath}>)\n\n## Audio\n\n![Source audio](<${audioPath}>)`,
    });
    const image = page.getByRole("img", { name: "Source image", exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(1);
    const audio = page.locator("audio");
    await expect(audio).toHaveCount(1);
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration))
      .toBe(1);
    const resource = await audio.evaluate(async (element: HTMLAudioElement) => {
      const response = await fetch(element.currentSrc, { headers: { Range: "bytes=0-3" } });
      return {
        source: element.currentSrc,
        status: response.status,
        range: response.headers.get("Content-Range"),
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
        paused: element.paused,
      };
    });
    expect(resource).toMatchObject({
      status: 206,
      range: "bytes 0-3/8044",
      bytes: [82, 73, 70, 70],
      paused: true,
    });
    expect(resource.source).toMatch(/^app:\/\/fs\//u);
    const imageNode = await image.elementHandle();
    const audioNode = await audio.elementHandle();
    if (!imageNode || !audioNode) throw new Error("Native message media did not mount");
    const trigger = page.getByRole("button", { name: "Source image", exact: true });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await trigger.focus();
    await command({ type: "complete" });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    expect(await image.evaluate((element, original) => element === original, imageNode)).toBe(true);
    expect(await audio.evaluate((element, original) => element === original, audioNode)).toBe(true);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await image.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open image in new tab", exact: true }).click();
    const imageTab = page.getByRole("tab", { name: /message-image\.png/u });
    const imageTabChrome = imageTab.locator("xpath=ancestor::*[@data-panel-tab-id][1]");
    await expect(imageTab).toBeVisible();
    await expect(page.getByRole("button", { name: /^Zoom, /u })).toBeVisible();
    const openedImages = page.getByRole("img", { name: "Source image", exact: true });
    await expect(openedImages).toHaveCount(2);
    await expect
      .poll(() =>
        openedImages.evaluateAll((elements) =>
          elements.every((element) => (element as HTMLImageElement).naturalWidth === 1),
        ),
      )
      .toBe(true);
    await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resize", exact: true })).toHaveCount(0);
    await imageTab.dblclick();
    await expect(imageTabChrome).not.toHaveAttribute("data-app-shell-tab-preview", "true");
    await page.reload();
    await page.evaluate(() => window.api?.awaitInitialization?.());
    await expect(imageTab).toBeVisible();
    await expect(imageTabChrome).not.toHaveAttribute("data-app-shell-tab-preview", "true");
    await expect(page.getByRole("button", { name: /^Zoom, /u })).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: "Source image", exact: true })
          .evaluateAll(
            (elements) =>
              elements.length > 0 &&
              elements.every((element) => (element as HTMLImageElement).naturalWidth === 1),
          ),
      )
      .toBe(true);
    await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resize", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    await testInfo.attach("native-message-media", {
      body: JSON.stringify({ resource, errors }),
      contentType: "application/json",
    });
  } finally {
    await harness.close();
  }
});
