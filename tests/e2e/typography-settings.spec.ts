import { expect, test, type Page } from "@playwright/test";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import {
  ElectronScenarioHarness,
  waitForNodexWindowInitialization,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { createAgentSmokeDraft, sendAgentPrompt } from "./support/agent-smoke-harness";
import { openBoardPageFromCard } from "./support/open-board-page";

interface TypographyObservation {
  ui: number;
  composer: number;
  prose: number;
  proseLine: number;
  code: number;
  codeLine: number;
  page: number;
  proseFamily: string;
  composerFamily: string;
  pageFamily: string;
}
interface EvidenceClaim {
  name: string;
  expected: unknown;
  actual: unknown;
}

const openAppearance = async (page: Page) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Appearance", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "UI font size", exact: true })).toBeVisible();
};
const returnToApp = async (page: Page) => {
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to app", exact: true })).toHaveCount(0);
};
const changeSize = async (page: Page, role: "UI" | "Code" | "Page", value: number) => {
  const input = page.getByRole("spinbutton", { name: `${role} font size`, exact: true });
  await input.fill(String(value));
  await input.press("Enter");
  await expect(input).toHaveValue(String(value));
};
const holdReviewFrame = async (page: Page) => {
  await page.mouse.move(150, 850);
  // Assertions own settling; this pause makes the native review recording readable.
  await page.waitForTimeout(1000);
};
const readChatTypography = async (page: Page) => {
  await expect(
    page.locator('[data-content-search-unit-key] [data-streamdown="code-block-body"] pre'),
  ).toBeAttached();
  await expect(page.locator('[data-codex-composer="true"]')).toBeAttached();
  return page.evaluate(() => {
    const requireElement = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing conversation typography surface: ${selector}`);
      return element;
    };
    const prose = requireElement("[data-content-search-unit-key] .codex-markdown p");
    const composer = requireElement('[data-codex-composer="true"]');
    const code = requireElement(
      '[data-content-search-unit-key] [data-streamdown="code-block-body"] pre',
    );
    const proseStyle = getComputedStyle(prose);
    const codeStyle = getComputedStyle(code);
    const composerStyle = getComputedStyle(composer);
    return {
      ui: Number.parseFloat(getComputedStyle(document.body).fontSize),
      composer: Number.parseFloat(composerStyle.fontSize),
      prose: Number.parseFloat(proseStyle.fontSize),
      proseLine: Number.parseFloat(proseStyle.lineHeight),
      code: Number.parseFloat(codeStyle.fontSize),
      codeLine: Number.parseFloat(codeStyle.lineHeight),
      proseFamily: proseStyle.fontFamily,
      composerFamily: composerStyle.fontFamily,
    };
  });
};

const readTypography = async (
  pageSurface: Page,
  pageId: string,
  chatSurface: Page,
): Promise<TypographyObservation> => {
  await expect(
    pageSurface.locator(
      `[data-page-stage-page-id="${pageId}"] .bn-editor .bn-block-content[data-content-type="paragraph"]`,
    ),
  ).toBeVisible();
  const [chat, page] = await Promise.all([
    readChatTypography(chatSurface),
    pageSurface.evaluate((id) => {
      const element = document.querySelector<HTMLElement>(
        `[data-page-stage-page-id="${id}"] .bn-editor .bn-block-content[data-content-type="paragraph"]`,
      );
      if (!element) throw new Error("Missing real Page paragraph");
      const style = getComputedStyle(element);
      return { page: Number.parseFloat(style.fontSize), pageFamily: style.fontFamily };
    }, pageId),
  ]);
  return { ...chat, ...page };
};

const readWindowTypography = async (page: Page) =>
  page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const prose = document.querySelector("[data-content-search-unit-key] .codex-markdown p");
    return {
      ui: Number.parseFloat(root.getPropertyValue("--font-ui-size")),
      code: Number.parseFloat(root.getPropertyValue("--font-code-size")),
      page: Number.parseFloat(root.getPropertyValue("--text-document")),
      prose: prose ? Number.parseFloat(getComputedStyle(prose).fontSize) : null,
      family: prose ? getComputedStyle(prose).fontFamily : null,
    };
  });

test("persists typography across real conversation, Page, settings and Electron windows", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const artifacts =
    process.env.NODEX_TYPOGRAPHY_UI_ARTIFACT_DIR ?? testInfo.outputPath("typography-review");
  await mkdir(artifacts, { recursive: true });
  const claims: EvidenceClaim[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    expect(actual, name).toEqual(expected);
    claims.push({ name, expected, actual });
  };
  const harness = await ElectronScenarioHarness.create({
    label: "typography-settings",
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
  const fakeDirectory = path.join(harness.profile.runRoot, ".fake-codex");
  await mkdir(fakeDirectory, { recursive: true });
  await writeFile(
    path.join(fakeDirectory, "state.json"),
    JSON.stringify({
      thread: null,
      turns: [],
      turnSequence: 0,
      queueSequence: 0,
      queuedSubmissions: [],
    }),
  );
  const command = (value: object) =>
    appendFile(path.join(fakeDirectory, "commands.jsonl"), `${JSON.stringify(value)}\n`);
  let recording: Page | null = null;
  let page: Page | null = null;
  let status: "passed" | "failed" = "failed";
  let failure: string | null = null;
  try {
    page = await harness.launch();
    await page.setViewportSize({ width: 1440, height: 960 });
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      "Typography review",
    );
    const pageId = createUuidV7();
    const seed = new RendererIpcSeedAdapter(page);
    await seed.createPage({
      key: "typography-page",
      projectId: draft.projectId,
      pageId,
      operationId: createUuidV7(),
      status: "plan",
      title: "Typography Page",
      nfm: "# Typography Page\n\nPage body keeps its own size.\n\n```text\nPage code uses the code preference.\n```",
    });
    await sendAgentPrompt(page, draft.projectSessionId, "Show typography for this task");
    await expect(page.getByText("The task completed successfully.", { exact: true })).toBeVisible();
    await command({ type: "start" });
    await command({
      type: "delta",
      delta: `\n\nConversation body keeps its reading rhythm.\n\n## Typography heading\n\n\`\`\`text\nConversation code uses the code preference.\n\`\`\``,
    });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Typography heading", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('[data-content-search-unit-key] [data-streamdown="code-block-body"] pre'),
    ).toHaveText("Conversation code uses the code preference.");
    await command({ type: "complete" });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect.poll(() => readChatTypography(page!).then((value) => value.code)).toBe(12);
    const threadId = await page
      .locator('[data-app-action-sidebar-thread-active="true"]')
      .getAttribute("data-app-action-sidebar-thread-id");
    if (!threadId) throw new Error("Missing active conversation identity");
    const newWindow = harness.application.waitForEvent("window");
    expect(
      await page.evaluate((active) => window.api!.invoke("window:new", active), {
        activeProjectSessionId: draft.projectSessionId,
        activeProjectId: draft.projectId,
      }),
    ).toBe(true);
    const second = await newWindow;
    await waitForNodexWindowInitialization(second);
    await expect.poll(() => readWindowTypography(second).then((value) => value.prose)).toBe(14);
    await page.bringToFront();

    await page.screencast.start({
      path: path.join(artifacts, "review.webm"),
      size: { width: 1440, height: 960 },
      annotate: { position: "bottom", fontSize: 14 },
    });
    recording = page;
    const defaultChat = await readChatTypography(page);
    claim(
      "The recorded conversation starts at prose/composer 14 and code 12",
      { prose: 14, composer: 14, code: 12 },
      { prose: defaultChat.prose, composer: defaultChat.composer, code: defaultChat.code },
    );
    await holdReviewFrame(page);
    await page.screenshot({ path: path.join(artifacts, "default.png") });
    await page.getByRole("button", { name: "Open Typography review", exact: true }).click();
    await openBoardPageFromCard({
      card: page.locator(`[data-board-uuid-v7="${pageId}"]`),
      page,
      tabName: "Typography Page",
    });
    await expect(page.locator(`[data-page-stage-page-id="${pageId}"] .bn-editor`)).toBeVisible();
    const baseline = await readTypography(page, pageId, second);
    await holdReviewFrame(page);
    claim(
      "Default sizes: UI, conversation, composer 14; code 12; Page 14",
      { ui: 14, prose: 14, composer: 14, proseLine: 22.75, code: 12, codeLine: 20, page: 14 },
      {
        ui: baseline.ui,
        prose: baseline.prose,
        composer: baseline.composer,
        proseLine: baseline.proseLine,
        code: baseline.code,
        codeLine: baseline.codeLine,
        page: baseline.page,
      },
    );
    await openAppearance(page);
    claim(
      "Settings show their effective defaults",
      ["14", "12", "14"],
      await Promise.all(
        ["UI", "Code", "Page"].map((role) =>
          page!.getByRole("spinbutton", { name: `${role} font size`, exact: true }).inputValue(),
        ),
      ),
    );
    await changeSize(page, "UI", 16);
    await returnToApp(page);
    await expect
      .poll(() =>
        readTypography(page!, pageId, second).then((value) => ({
          ui: value.ui,
          prose: value.prose,
          composer: value.composer,
          proseLine: value.proseLine,
          code: value.code,
          page: value.page,
        })),
      )
      .toEqual({ ui: 16, prose: 16, composer: 16, proseLine: 26, code: 12, page: 14 });
    const scaled = await readTypography(page, pageId, second);
    claim(
      "UI 16 scales conversation and composer; code and Page remain independent",
      { ui: 16, prose: 16, composer: 16, code: 12, page: 14 },
      {
        ui: scaled.ui,
        prose: scaled.prose,
        composer: scaled.composer,
        code: scaled.code,
        page: scaled.page,
      },
    );
    await expect
      .poll(() => readWindowTypography(second))
      .toMatchObject({ ui: 16, prose: 16, code: 12, page: 14 });
    claim(
      "Existing second window receives UI update",
      { ui: 16, prose: 16, code: 12, page: 14 },
      Object.fromEntries(
        Object.entries(await readWindowTypography(second)).filter(([key]) => key !== "family"),
      ),
    );

    await openAppearance(page);
    await changeSize(page, "Page", 18);
    await changeSize(page, "Code", 16);
    const contentFamily = page.getByRole("textbox", { name: /^(Light|Dark) Content font$/u });
    await contentFamily.fill("Georgia");
    await contentFamily.press("Enter");
    claim(
      "Configured Appearance controls show UI 16, code 16, Page 18 and content Georgia",
      { sizes: ["16", "16", "18"], content: "Georgia" },
      {
        sizes: await Promise.all(
          ["UI", "Code", "Page"].map((role) =>
            page!.getByRole("spinbutton", { name: `${role} font size`, exact: true }).inputValue(),
          ),
        ),
        content: await contentFamily.inputValue(),
      },
    );
    await holdReviewFrame(page);
    await page.screenshot({ path: path.join(artifacts, "appearance.png") });
    await returnToApp(page);
    await expect
      .poll(() =>
        readTypography(page!, pageId, second).then((value) => ({
          prose: value.prose,
          code: value.code,
          codeLine: value.codeLine,
          page: value.page,
          content: value.proseFamily.includes("Georgia"),
          pageContent: value.pageFamily.includes("Georgia"),
          ui: value.composerFamily.includes("Georgia"),
        })),
      )
      .toEqual({
        prose: 16,
        code: 16,
        codeLine: 24,
        page: 18,
        content: true,
        pageContent: true,
        ui: false,
      });
    const final = await readTypography(page, pageId, second);
    claim(
      "Independent Page/code size and content family",
      { prose: 16, code: 16, codeLine: 24, page: 18, content: true, pageContent: true, ui: false },
      {
        prose: final.prose,
        code: final.code,
        codeLine: final.codeLine,
        page: final.page,
        content: final.proseFamily.includes("Georgia"),
        pageContent: final.pageFamily.includes("Georgia"),
        ui: final.composerFamily.includes("Georgia"),
      },
    );
    await expect
      .poll(() =>
        readWindowTypography(second).then((value) => ({
          ui: value.ui,
          code: value.code,
          page: value.page,
          content: value.family?.includes("Georgia"),
        })),
      )
      .toEqual({ ui: 16, code: 16, page: 18, content: true });
    claim(
      "Existing second window receives independent size and family updates",
      { ui: 16, code: 16, page: 18, content: true },
      {
        ...Object.fromEntries(
          Object.entries(await readWindowTypography(second)).filter(
            ([key]) => key !== "family" && key !== "prose",
          ),
        ),
        content: (await readWindowTypography(second)).family?.includes("Georgia"),
      },
    );
    await page.locator(`[data-app-action-sidebar-thread-id="${threadId}"]`).click();
    await expect(
      page.locator("[data-content-search-unit-key] .codex-markdown p").first(),
    ).toBeVisible();
    const recordedChat = await readChatTypography(page);
    claim(
      "Recorded configured conversation shows prose/composer 16 and code 16 with separate content family",
      { prose: 16, composer: 16, code: 16, codeLine: 24, content: true, ui: false },
      {
        prose: recordedChat.prose,
        composer: recordedChat.composer,
        code: recordedChat.code,
        codeLine: recordedChat.codeLine,
        content: recordedChat.proseFamily.includes("Georgia"),
        ui: recordedChat.composerFamily.includes("Georgia"),
      },
    );
    await holdReviewFrame(page);
    await page.screenshot({ path: path.join(artifacts, "configured-chat.png") });
    await page.getByRole("button", { name: "Open Typography review", exact: true }).click();
    await page.getByRole("tab", { name: "Typography Page", exact: true }).click();
    await expect(page.locator(`[data-page-stage-page-id="${pageId}"] .bn-editor`)).toBeVisible();
    await page.reload();
    await waitForNodexWindowInitialization(page);
    await openBoardPageFromCard({
      card: page.locator(`[data-board-uuid-v7="${pageId}"]`),
      page,
      tabName: "Typography Page",
    });
    await expect(
      page.locator(
        `[data-page-stage-page-id="${pageId}"] .bn-editor .bn-block-content[data-content-type="paragraph"]`,
      ),
    ).toBeVisible();
    await expect
      .poll(() =>
        readTypography(page!, pageId, second).then((value) => ({
          ui: value.ui,
          code: value.code,
          page: value.page,
          content: value.proseFamily.includes("Georgia"),
        })),
      )
      .toEqual({ ui: 16, code: 16, page: 18, content: true });
    const reopened = await readTypography(page, pageId, second);
    claim(
      "Renderer reopen preserves the effective typography",
      { ui: 16, code: 16, page: 18, content: true },
      {
        ui: reopened.ui,
        code: reopened.code,
        page: reopened.page,
        content: reopened.proseFamily.includes("Georgia"),
      },
    );
    await holdReviewFrame(page);
    await page.screenshot({ path: path.join(artifacts, "final.png") });
    await page.screencast.stop();
    recording = null;
    expect((await stat(path.join(artifacts, "review.webm"))).size).toBeGreaterThan(0);
    page = await harness.restart();
    await expect
      .poll(() => readWindowTypography(page!))
      .toMatchObject({ ui: 16, code: 16, page: 18 });
    const restarted = await readWindowTypography(page);
    claim(
      "Cold Electron restart preserves preferences",
      { ui: 16, code: 16, page: 18 },
      { ui: restarted.ui, code: restarted.code, page: restarted.page },
    );
    await page.getByRole("button", { name: "Open Typography review", exact: true }).click();
    await openBoardPageFromCard({
      card: page.locator(`[data-board-uuid-v7="${pageId}"]`),
      page,
      tabName: "Typography Page",
    });
    await expect(
      page.locator(
        `[data-page-stage-page-id="${pageId}"] .bn-editor .bn-block-content[data-content-type="paragraph"]`,
      ),
    ).toBeVisible();
    const coldContent = await page.evaluate((id) => {
      const paragraph = document.querySelector<HTMLElement>(
        `[data-page-stage-page-id="${id}"] .bn-editor .bn-block-content[data-content-type="paragraph"]`,
      );
      if (!paragraph) throw new Error("Missing reopened Page paragraph");
      const style = getComputedStyle(paragraph);
      return {
        rootContent: getComputedStyle(document.documentElement)
          .getPropertyValue("--font-content")
          .includes("Georgia"),
        pageContent: style.fontFamily.includes("Georgia"),
        page: Number.parseFloat(style.fontSize),
      };
    }, pageId);
    claim(
      "Cold Electron restart preserves content family on root and actual Page",
      { rootContent: true, pageContent: true, page: 18 },
      coldContent,
    );
    status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await page?.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => undefined);
    throw error;
  } finally {
    if (recording) await recording.screencast.stop().catch(() => undefined);
    await writeFile(
      path.join(artifacts, "result.json"),
      `${JSON.stringify({ status, fixture: "typography-settings: public Page seed + native synthetic transcript", claims, failure }, null, 2)}\n`,
    );
    await writeFile(
      path.join(artifacts, "README.md"),
      `# Typography verification\n\nStatus: **${status}**\n\nFresh disposable Electron Profile; Pages were created through typed public lifecycle operations and chat content arrived through the native transcript fixture. No user Profile was accessed.\n\nThe single native recording shows default chat and Page sizes, real Appearance setting edits, the configured chat, independently sized Page/code content, content-family separation, and renderer reopening. Each recorded claim has exact expected/actual evidence in result.json. Cold Electron restart is asserted after the recording.\n\nScreenshots: default.png (default chat), appearance.png (configured settings), configured-chat.png (configured chat), final.png (reopened Page).\n\n${claims.map((entry) => `- ${entry.name}`).join("\n")}\n${failure ? `\nFailure: ${failure}\n` : ""}`,
    );
    await harness.close();
  }
});
