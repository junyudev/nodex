import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import { invokeIpc } from "./support/editor-scenario";
import { chooseComposerModel } from "./support/composer-model-picker";
import { openNewChatDraft } from "./support/new-chat-draft";
import { captureRendererErrors } from "./support/renderer-errors";

interface NativePrompt {
  readonly event?: string;
  readonly type?: string;
  readonly threadId?: string;
  readonly sessionId?: string;
  readonly prompt?: string;
  readonly content?: string | readonly { readonly type: string; readonly text?: string }[];
  readonly priorItems?: unknown;
  readonly priorPromptTexts?: readonly string[];
}

const nativePromptText = (record: NativePrompt | undefined): string => {
  if (record?.prompt !== undefined) return record.prompt;
  if (typeof record?.content === "string") return record.content;
  return (
    record?.content?.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n") ??
    ""
  );
};

const nativeRecords = (file: string): readonly NativePrompt[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as NativePrompt)
    : [];

const nativePrompts = (file: string) =>
  nativeRecords(file).filter((record) => record.type === "prompt" || record.event === "prompt");

/** The selection omits the secret, so its presence in native history proves inheritance. */
async function selectReply(page: Page, reply: Locator, text: string) {
  await reply.scrollIntoViewIfNeeded();
  await reply.evaluate((element, selectedText) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent?.indexOf(selectedText) ?? -1;
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + selectedText.length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`The reply has no selectable ${selectedText}`);
  }, text);
  await expect(page.getByRole("button", { name: "Ask in side chat", exact: true })).toBeVisible();
}

for (const kind of ["codex", "claude"] as const) {
  test(`${kind} side chat captures the current context before Send and keeps later messages isolated`, async ({}, testInfo) => {
    test.setTimeout(180_000);
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), `nodex-${kind}-side-chat-`));
    const firstSidePrompt = "Verify handoff **side** ONLY_SIDECAR";
    const sideTitle = "Verify handoff side ONLY_SIDECAR";
    const releaseFile = path.join(fixture, "release-first-side-reply");
    const titleEvidence =
      process.env.NODEX_E2E_FIRST_MESSAGE_TITLE_DIR ?? testInfo.outputPath("first-message-title");
    const titleClaims: { name: string; expected: unknown; actual: unknown; recorded: boolean }[] =
      [];
    const checkTitle = (name: string, expected: unknown, actual: unknown) => {
      titleClaims.push({ name, expected, actual, recorded: kind === "codex" });
      expect(actual, name).toEqual(expected);
    };
    const codex = path.join(fixture, "codex");
    const codexPeer = fs
      .readFileSync("tests/e2e/fixtures/agent-runtime-cross-provider-peer.mjs", "utf8")
      .replace(/^#![^\n]*\n/u, "");
    fs.writeFileSync(codex, `#!${process.execPath}\n${codexPeer}`, { mode: 0o755 });
    fs.writeFileSync(path.join(fixture, "plan.json"), "{}");
    const harness = await ElectronScenarioHarness.create({
      label: `${kind}-side-chat-context`,
      prepareAgentRuntime: false,
      environment: {
        NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
        NODEX_TEST_CROSS_PROVIDER_HOME: fixture,
        NODEX_TEST_NATIVE_HOLD_PROMPT: firstSidePrompt,
        NODEX_TEST_NATIVE_RELEASE_FILE: releaseFile,
        NODEX_LOG_FILE: "1",
        NODEX_LOG_FILE_LEVEL: "debug",
      },
    });
    prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, codex, "0.145.0-alpha.15");
    const claudeHome = path.join(fixture, "claude-home");
    const nativeLog =
      kind === "claude"
        ? path.join(claudeHome, "observations.jsonl")
        : path.join(fixture, "native.jsonl");
    const prompts = () => nativePrompts(nativeLog);
    let readRendererErrors = async () => "";
    let page: Page | undefined;
    let recording = false;
    let passed = false;
    try {
      page = await harness.launch();
      readRendererErrors = captureRendererErrors(page);
      await harness.waitForApplicationReady();
      await page.setViewportSize({ width: 1440, height: 960 });
      if (kind === "claude") {
        const binaryPath = path.join(fixture, "claude");
        const peer = pathToFileURL(
          path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"),
        );
        fs.writeFileSync(
          binaryPath,
          `#!${process.execPath}\nimport(${JSON.stringify(peer.href)});\n`,
          {
            mode: 0o755,
          },
        );
        await invokeIpc(page, "settings:claude-agents:update", {
          instances: [
            {
              id: "side-chat-fixture",
              displayName: "Claude Code",
              binaryPath,
              configDirectory: claudeHome,
              enabled: true,
              customModels: [],
              environment: [],
            },
          ],
        });
      }
      await invokeIpc(page, "agent-runtime:providers:read", { refresh: true });
      const scene = await openNewChatDraft(page);
      const owner = await scene.getAttribute("data-workbench-scene-owner");
      if (!owner?.startsWith("session:")) throw new Error("The source chat has no Session");
      const sourceId = owner.slice("session:".length);
      if (kind === "claude") await chooseComposerModel(page, "Claude Opus 5", "Claude Opus 5");
      const composers = scene.locator('[data-codex-composer="true"]:visible');
      const mainComposer = composers.first();
      const send = async (composer: Locator, sessionId: string, text: string) => {
        const previousCount = prompts().length;
        await composer.fill(text);
        await composer.press("Enter");
        await expect.poll(() => prompts().length, { timeout: 30_000 }).toBe(previousCount + 1);
        await expect
          .poll(
            async () => {
              const conversation = await invokeIpc(page!, "agent-runtime:session:read", {
                sessionId,
              });
              return conversation.snapshot.projection.runs.at(-1)?.status;
            },
            { timeout: 30_000 },
          )
          .toBe("completed");
      };

      await send(mainComposer, sourceId, "Verify handoff origin ORCHID");
      const source = await invokeIpc(page, "project-sessions:get", sourceId);
      const response = scene.locator("[data-response-annotation-target] .codex-markdown").first();
      await expect(response).toContainText(
        kind === "codex" ? "Codex child report" : "Native handoff verified",
      );
      await mainComposer.fill("Keep my main draft");
      const selectedText = kind === "codex" ? "child report" : "Native handoff verified";
      await selectReply(page, response, selectedText);
      await page.getByRole("button", { name: "Ask in side chat", exact: true }).click();
      await expect(composers).toHaveCount(2);
      const sideComposer = composers.last().describe("Side chat message");
      const sidePanel = page.locator('[role="tabpanel"][data-tab-id^="sidechat-session:"]');
      const fadeSelector = "[data-app-shell-main-content-top-fade]";
      const mainFade = scene.getByTestId("session-thread-page").locator(fadeSelector);
      const sideFade = sidePanel.locator(fadeSelector);
      await expect(sideFade).toHaveCSS("height", "40px");
      await expect(sideFade).toHaveCSS("opacity", "1");
      await expect(sideFade).toHaveCSS("pointer-events", "none");
      const mainGradient = await mainFade.evaluate(
        (element) => getComputedStyle(element).backgroundImage,
      );
      expect(mainGradient).not.toBe("none");
      await expect(sideFade).toHaveCSS("background-image", mainGradient);
      await expect(sideComposer).toBeFocused();
      await expect(mainComposer).toHaveText("Keep my main draft");
      await expect(sideComposer).toHaveText("");
      await expect(page.getByRole("button", { name: "1 selection", exact: true })).toBeVisible();
      const tab = page.locator('[data-panel-tab-id^="sidechat-session:"]').first();
      await expect(tab).toBeVisible();
      const sideId = (await tab.getAttribute("data-panel-tab-id"))?.slice(
        "sidechat-session:".length,
      );
      if (!sideId) throw new Error("The side chat has no bound Session");
      const child = await invokeIpc(page, "project-sessions:get", sideId);
      expect(child?.executionRef?.threadId).toBeTruthy();
      expect(child?.executionRef?.threadId).not.toBe(source?.executionRef?.threadId);
      expect(
        (await invokeIpc(page, "agent-runtime:session:inspect", { sessionId: sideId })).thread
          .modelSelection.instanceId,
      ).toBe(
        kind === "codex"
          ? "codex"
          : agentRuntimeProviderId({ kind, instanceConfigId: "side-chat-fixture" }),
      );
      expect(
        (await invokeIpc(page, "agent-runtime:session:read", { sessionId: sideId })).snapshot
          .projection.runs,
      ).toHaveLength(0);
      expect(
        (await invokeIpc(page, "workspace:tasks:list", child?.projectId ?? null)).items.map(
          (item) => item.id,
        ),
      ).not.toContain(sideId);
      await expect(scene.locator("[data-response-annotation-target]")).toHaveCount(1);
      expect(prompts()).toHaveLength(1);

      await sideComposer.fill(firstSidePrompt);
      await selectReply(page, response, selectedText);
      await page.getByRole("button", { name: "Ask in side chat", exact: true }).click();
      await expect(page.getByRole("button", { name: "2 selections", exact: true })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Side chat", exact: true })).toHaveCount(1);
      await expect(sideComposer).toHaveText(firstSidePrompt);
      await send(mainComposer, sourceId, "Verify handoff later LATER_PARENT");
      expect(prompts()).toHaveLength(2);
      if (kind === "codex") {
        fs.mkdirSync(titleEvidence, { recursive: true });
        await page.screencast.start({
          path: path.join(titleEvidence, "review.webm"),
          size: { width: 1440, height: 960 },
        });
        await page.screencast.showActions({
          position: "bottom",
          style: { title: "font-size: 14px" },
        });
        recording = true;
      }
      await sideComposer.press("Enter");
      await expect.poll(() => prompts().length, { timeout: 30_000 }).toBe(3);
      const replyIsHeld = () =>
        nativeRecords(nativeLog).some(
          (record) =>
            (record.type === "response.held" || record.event === "response.held") &&
            record.prompt === firstSidePrompt,
        );
      await expect.poll(replyIsHeld).toBe(true);
      const namedTab = page.getByRole("tab", { name: sideTitle, exact: true });
      await expect(namedTab).toBeVisible();
      checkTitle(
        "The first message names the tab using plain text",
        sideTitle,
        await namedTab.getAttribute("aria-label"),
      );
      await expect
        .poll(
          async () =>
            (
              await invokeIpc(page!, "agent-runtime:session:read", { sessionId: sideId })
            ).snapshot.projection.runs.at(-1)?.status,
        )
        .toBe("running");
      checkTitle(
        "The title is visible before the first reply completes",
        "running",
        (
          await invokeIpc(page, "agent-runtime:session:read", { sessionId: sideId })
        ).snapshot.projection.runs.at(-1)?.status,
      );
      checkTitle("The native reply remains held while the title is visible", true, replyIsHeld());
      await expect(sidePanel.locator("[data-response-annotation-target]")).toHaveCount(0);
      checkTitle(
        "No assistant reply is required to name the tab",
        0,
        await sidePanel.locator("[data-response-annotation-target]").count(),
      );
      checkTitle(
        "The temporary Session retains the admitted title",
        sideTitle,
        (await invokeIpc(page, "project-sessions:get", sideId))?.displayTitle,
      );
      if (recording) {
        await namedTab.locator("[data-app-shell-tab-title]").hover();
        const tooltip = page.getByRole("tooltip", { name: sideTitle, exact: true });
        await expect(tooltip).toBeVisible();
        checkTitle(
          "The first title is readable in the tab tooltip before the reply",
          sideTitle,
          await tooltip.innerText(),
        );
        await page.waitForTimeout(700);
        await page.mouse.move(1160, 600);
      }
      fs.writeFileSync(releaseFile, "release");
      const sidePrompt = prompts().at(-1);
      expect(nativePromptText(sidePrompt)).toContain("ONLY_SIDECAR");
      expect(nativePromptText(sidePrompt)).not.toContain("ORCHID");
      const inherited = JSON.stringify(sidePrompt?.priorItems ?? sidePrompt?.priorPromptTexts);
      expect(inherited).toContain("ORCHID");
      expect(inherited).not.toContain("LATER_PARENT");
      expect(sidePrompt?.threadId ?? sidePrompt?.sessionId).not.toBe(
        prompts()[0]?.threadId ?? prompts()[0]?.sessionId,
      );
      await expect
        .poll(
          async () =>
            (
              await invokeIpc(page!, "agent-runtime:session:read", { sessionId: sideId })
            ).snapshot.projection.runs.at(-1)?.status,
          { timeout: 30_000 },
        )
        .toBe("completed");
      await expect(
        sidePanel.locator('[data-user-message-bubble="true"]', { hasText: "ONLY_SIDECAR" }),
      ).toHaveCount(1);
      await expect(
        sidePanel.getByText("Verify handoff origin ORCHID", { exact: true }),
      ).toHaveCount(0);
      const sideConversation = await invokeIpc(page, "agent-runtime:session:read", {
        sessionId: sideId,
      });
      expect(sideConversation.snapshot.projection.runs).toHaveLength(1);
      await send(sideComposer, sideId, "Verify handoff later message KEEP_FIRST_TITLE");
      await expect(namedTab).toBeVisible();
      checkTitle(
        "A later side message keeps the first title",
        sideTitle,
        await namedTab.getAttribute("aria-label"),
      );
      checkTitle(
        "A later message keeps the Session title",
        sideTitle,
        (await invokeIpc(page, "project-sessions:get", sideId))?.displayTitle,
      );
      if (recording) {
        await namedTab.locator("[data-app-shell-tab-title]").hover();
        const tooltip = page.getByRole("tooltip", { name: sideTitle, exact: true });
        await expect(tooltip).toBeVisible();
        checkTitle(
          "The tab tooltip retains the first title after a later message",
          sideTitle,
          await tooltip.innerText(),
        );
        await page.waitForTimeout(800);
        await page.screenshot({
          path: path.join(titleEvidence, "final.png"),
          animations: "disabled",
        });
        await page.screencast.stop();
        recording = false;
      }
      await send(mainComposer, sourceId, "Verify handoff source SOURCE_ONLY");
      const resumedSource = prompts().at(-1);
      expect(resumedSource?.threadId ?? resumedSource?.sessionId).toBe(
        prompts()[0]?.threadId ?? prompts()[0]?.sessionId,
      );
      expect(
        JSON.stringify(resumedSource?.priorItems ?? resumedSource?.priorPromptTexts),
      ).not.toContain("ONLY_SIDECAR");
      const sourceHistory = await invokeIpc(page, "agent-runtime:session:read", {
        sessionId: sourceId,
      });
      expect(JSON.stringify(sourceHistory)).not.toContain("ONLY_SIDECAR");
      const evidence =
        process.env.NODEX_E2E_EVIDENCE_DIR ?? testInfo.outputPath("side-chat-context");
      fs.mkdirSync(evidence, { recursive: true });
      await testInfo.attach(`${kind}-side-chat-isolation`, {
        body: await page.screenshot({
          path: path.join(evidence, `${kind}-side-chat-isolation.png`),
        }),
        contentType: "image/png",
      });

      // A used side chat can be kept by cancelling; confirming removes its temporary Session.
      const close = tab.locator('[data-app-shell-tab-close-button="true"]');
      await expect(close).toHaveAccessibleName(`Close ${sideTitle} tab`);
      await close.click();
      const confirmation = page.getByRole("dialog", { name: "Close side chat?", exact: true });
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(confirmation).toBeHidden();
      await expect(composers).toHaveCount(2);
      expect(await invokeIpc(page, "project-sessions:get", sideId)).not.toBeNull();
      await close.click();
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole("button", { name: "Close side chat", exact: true }).click();
      await expect(composers).toHaveCount(1);
      await expect.poll(() => invokeIpc(page!, "project-sessions:get", sideId)).toBeNull();
      await expect(tab).toHaveCount(0);

      // Merely opening a side chat does not create local work or require a close confirmation.
      await selectReply(page, response, selectedText);
      await page.getByRole("button", { name: "Ask in side chat", exact: true }).click();
      await expect(composers).toHaveCount(2);
      await expect(tab).toBeVisible();
      const untouchedId = (await tab.getAttribute("data-panel-tab-id"))?.slice(
        "sidechat-session:".length,
      );
      if (!untouchedId) throw new Error("The untouched side chat has no Session");
      await expect(close).toHaveAccessibleName("Close Side chat tab");
      await close.click();
      await expect(composers).toHaveCount(1);
      await expect(confirmation).toBeHidden();
      await expect.poll(() => invokeIpc(page!, "project-sessions:get", untouchedId)).toBeNull();
      expect(prompts()).toHaveLength(5);
      expect(await readRendererErrors()).toBe("");
      passed = true;
    } catch (error) {
      if (page)
        await testInfo.attach("failure-state", {
          body: await page
            .locator("body")
            .ariaSnapshot()
            .catch(() => "Unavailable"),
          contentType: "text/plain",
        });
      throw error;
    } finally {
      fs.writeFileSync(releaseFile, "release");
      if (recording && page && !page.isClosed()) await page.screencast.stop();
      fs.mkdirSync(titleEvidence, { recursive: true });
      fs.writeFileSync(
        path.join(titleEvidence, kind === "codex" ? "result.json" : "claude-result.json"),
        JSON.stringify(
          {
            status: passed ? "passed" : "failed",
            fixture: "side-chat-first-message-title/native-peers-v1",
            provider: kind,
            claims: titleClaims,
          },
          null,
          2,
        ),
      );
      if (kind === "codex")
        fs.writeFileSync(
          path.join(titleEvidence, "README.md"),
          `# Name a side chat from its first message\n\nStatus: ${passed ? "passed" : "failed"}.\n\nThe native recording starts after source and draft setup. It shows Send naming the side tab from the first message while the provider reply is held, then a later message retaining the title. Markdown and attached selection context do not become title syntax. final.png captures the later completed message with the first title still present.\n\nresult.json records exact expected and actual claims. Claude Code exercises the same native SDK boundary and records its assertions in claude-result.json. The provider peers use an explicit file release gate so admission can be checked before any assistant reply completes.\n`,
        );
      await testInfo.attach(`${kind}-renderer-errors`, {
        body: await readRendererErrors(),
        contentType: "text/plain",
      });
      await testInfo.attach(`${kind}-runtime.log`, {
        body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile, 100_000)),
        contentType: "text/plain",
      });
      await testInfo.attach(`${kind}-native.jsonl`, {
        body: fs.existsSync(nativeLog) ? fs.readFileSync(nativeLog) : Buffer.from(""),
        contentType: "text/plain",
      });
      await harness.close();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}
