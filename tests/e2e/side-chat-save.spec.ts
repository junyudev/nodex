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
  readonly content?: string | readonly { readonly text?: string }[];
  readonly priorItems?: unknown;
  readonly priorPromptTexts?: readonly string[];
}

const promptText = (record: NativePrompt | undefined) => {
  if (record?.prompt !== undefined) return record.prompt;
  if (typeof record?.content === "string") return record.content;
  return (
    record?.content?.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n") ??
    ""
  );
};

const visibleSessionId = async (page: Page) =>
  (
    await page
      .locator('[data-workbench-scene-owner^="session:"]:visible')
      .first()
      .getAttribute("data-workbench-scene-owner")
  )?.slice("session:".length) ?? null;

const captureAlerts = async (page: Page) => {
  const handle = await page.evaluateHandle(() => {
    const messages = new Set<string>();
    const collect = () => {
      for (const alert of document.querySelectorAll('[role="alert"]')) {
        const text = alert.textContent?.trim();
        if (text) messages.add(text);
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    collect();
    return { messages, observer };
  });
  return {
    read: () => handle.evaluate(({ messages }) => [...messages]),
    dispose: async () => {
      await handle.evaluate(({ observer }) => observer.disconnect());
      await handle.dispose();
    },
  };
};

for (const kind of ["codex", "claude"] as const) {
  test(`${kind} saves a side chat with its draft and continues independently after restart`, async ({}, testInfo) => {
    test.setTimeout(180_000);
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), `nodex-${kind}-side-save-`));
    const codex = path.join(fixture, "codex");
    fs.writeFileSync(
      codex,
      `#!${process.execPath}\n${fs.readFileSync("tests/e2e/fixtures/agent-runtime-cross-provider-peer.mjs", "utf8").replace(/^#![^\n]*\n/u, "")}`,
      { mode: 0o755 },
    );
    const sourcePrompt =
      kind === "codex" ? "Our launch codename is ORCHID." : "Verify handoff launch code ORCHID";
    const sidePrompt =
      kind === "codex"
        ? "Create a concise launch checklist. Its ID is SCARLET."
        : "Verify handoff launch checklist SCARLET";
    const draft =
      kind === "codex"
        ? "Use the checklist to draft the launch announcement."
        : "Verify handoff draft the launch announcement from the checklist";
    const followUp =
      kind === "codex"
        ? "What are the codename and checklist ID? Continue the saved launch plan."
        : "Verify handoff continue the saved launch plan";
    fs.writeFileSync(
      path.join(fixture, "plan.json"),
      JSON.stringify({
        [sourcePrompt]: { reply: "ORCHID is the launch codename." },
        [sidePrompt]: {
          reply:
            "Launch checklist SCARLET\n\n- Confirm the release build.\n- Name the rollout owner.\n- Draft the launch announcement.",
        },
        [draft]: {
          reply:
            "Draft announcement:\n\nORCHID is ready to launch. Complete checklist SCARLET, then confirm the rollout owner before announcing.",
        },
        [followUp]: { reply: "Continuing the saved plan: ORCHID · SCARLET." },
      }),
    );
    const harness = await ElectronScenarioHarness.create({
      label: `${kind}-side-chat-save`,
      prepareAgentRuntime: false,
      environment: {
        NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
        NODEX_TEST_CROSS_PROVIDER_HOME: fixture,
        NODEX_LOG_FILE: "1",
        NODEX_LOG_FILE_LEVEL: "debug",
      },
    });
    prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, codex, "0.145.0-alpha.15");
    const claudeHome = path.join(fixture, "claude-home");
    const log =
      kind === "codex"
        ? path.join(fixture, "native.jsonl")
        : path.join(claudeHome, "observations.jsonl");
    const prompts = (): readonly NativePrompt[] =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as NativePrompt)
            .filter((record) => record.event === "prompt" || record.type === "prompt")
        : [];
    const artifacts = process.env.NODEX_E2E_SAVE_ARTIFACT_DIR ?? testInfo.outputPath("save-chat");
    const titleEvidence = process.env.NODEX_E2E_FIRST_MESSAGE_TITLE_DIR;
    const savedTitleClaims: { name: string; expected: string; actual: unknown; recorded: false }[] =
      [];
    const claims: { name: string; recorded: boolean; expected: unknown; actual: unknown }[] = [];
    const check = (name: string, expected: unknown, actual: unknown, recorded = false) => {
      claims.push({ name, expected, actual, recorded });
      expect(actual, name).toEqual(expected);
    };
    const checkSavedTitle = (name: string, actual: unknown) => {
      savedTitleClaims.push({ name, expected: sidePrompt, actual, recorded: false });
      check(name, sidePrompt, actual, recording);
    };
    let page: Page | undefined;
    let readRendererErrors = async () => "";
    let saveAlerts: Awaited<ReturnType<typeof captureAlerts>> | undefined;
    let recording = false;
    let passed = false;
    let sourceId: string | null = null;
    let savedId: string | null = null;
    try {
      page = await harness.launch();
      readRendererErrors = captureRendererErrors(page);
      await harness.waitForApplicationReady();
      await page.setViewportSize({ width: 1440, height: 960 });
      if (kind === "claude") {
        const binaryPath = path.join(fixture, "claude");
        fs.writeFileSync(
          binaryPath,
          `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs")).href)});\n`,
          { mode: 0o755 },
        );
        await invokeIpc(page, "settings:claude-agents:update", {
          instances: [
            {
              id: "save-fixture",
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
      sourceId = await visibleSessionId(page);
      if (!sourceId) throw new Error("The source chat has no Session");
      if (kind === "claude") await chooseComposerModel(page, "Claude Opus 5", "Claude Opus 5");
      const sourceComposer = scene.locator('[data-codex-composer="true"]:visible').first();
      const send = async (composer: Locator, sessionId: string, text: string) => {
        const before = prompts().length;
        await composer.fill(text);
        await composer.press("Enter");
        await expect.poll(() => prompts().length, { timeout: 30_000 }).toBe(before + 1);
        await expect
          .poll(
            async () =>
              (
                await invokeIpc(page!, "agent-runtime:session:read", { sessionId })
              ).snapshot.projection.runs.at(-1)?.status,
            { timeout: 30_000 },
          )
          .toBe("completed");
      };
      await send(sourceComposer, sourceId, sourcePrompt);
      const source = await invokeIpc(page, "project-sessions:get", sourceId);
      if (!source?.executionRef) throw new Error("The source chat has no execution binding");
      const sourceRuns = (
        await invokeIpc(page, "agent-runtime:session:read", { sessionId: sourceId })
      ).snapshot.projection.runs;
      await page.getByRole("button", { name: "New tab", exact: true }).click();
      await page
        .getByRole("tabpanel", { name: "New tab", exact: true })
        .getByRole("button", { name: /^Side chat/u })
        .click();
      const tab = page.locator('[data-panel-tab-id^="sidechat-session:"]').first();
      await expect(tab).toBeVisible();
      const sideId = (await tab.getAttribute("data-panel-tab-id"))?.slice(
        "sidechat-session:".length,
      );
      if (!sideId) throw new Error("The side chat has no bound Session");
      const sideComposer = page
        .locator(`[role="tabpanel"][data-tab-id="sidechat-session:${sideId}"]`)
        .locator('[data-codex-composer="true"]');
      await send(sideComposer, sideId, sidePrompt);
      await expect(page.getByRole("tab", { name: sidePrompt, exact: true })).toBeVisible();
      const sideNativeId = prompts().at(-1)?.threadId ?? prompts().at(-1)?.sessionId;
      if (!sideNativeId) throw new Error("The side chat has no native execution identity");
      const sideInspection = await invokeIpc(page, "agent-runtime:session:inspect", {
        sessionId: sideId,
      });
      await sideComposer.fill(draft);
      saveAlerts = await captureAlerts(page);

      // Startup, provider probes and source/side seeding are complete before the native recording.
      if (kind === "codex") {
        fs.mkdirSync(artifacts, { recursive: true });
        await page.screencast.start({
          path: path.join(artifacts, "review.webm"),
          size: { width: 1440, height: 960 },
        });
        await page.screencast.showActions({
          position: "bottom",
          style: { title: "font-size: 14px" },
        });
        recording = true;
      }
      await tab
        .getByRole("button", { name: "Side chat actions", exact: true })
        .describe("Side chat actions")
        .click();
      const save = page
        .getByRole("menuitem", { name: "Save as chat", exact: true })
        .describe("Save as chat");
      await expect(save).toBeEnabled();
      if (recording) await page.waitForTimeout(700);
      await save.click();
      if (recording) await page.mouse.move(1160, 600);
      await expect
        .poll(
          async () => {
            savedId = await visibleSessionId(page!);
            return savedId !== null && savedId !== sourceId && savedId !== sideId;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      if (!savedId) throw new Error("The saved chat did not open its Session");
      check(
        "Save opens an independent Session",
        true,
        savedId !== sourceId && savedId !== sideId,
        true,
      );
      const saved = await invokeIpc(page, "project-sessions:get", savedId);
      if (!saved?.executionRef) throw new Error("The saved chat has no execution binding");
      checkSavedTitle("The saved chat inherits its side chat title", saved.displayTitle);
      check(
        "The saved chat stays in the source Project",
        source?.projectId,
        saved?.projectId,
        true,
      );
      const savedScene = page.locator(`[data-workbench-scene-owner="session:${savedId}"]`);
      const savedComposer = savedScene
        .locator('[data-codex-composer="true"]:visible')
        .first()
        .describe("Saved chat draft");
      await expect(savedComposer).toHaveText(draft);
      if (recording) {
        const pinnedSummary = page.getByRole("button", {
          name: "Toggle pinned summary",
          exact: true,
          pressed: true,
        });
        if (await pinnedSummary.isVisible()) await pinnedSummary.describe("Unpin summary").click();
        await savedComposer.click();
        await page.mouse.move(1160, 600);
        await page.waitForTimeout(700);
      }
      check(
        "The complete unsent draft moves to the saved chat",
        draft,
        await savedComposer.innerText(),
        true,
      );
      await expect(
        savedScene.locator('[data-user-message-bubble="true"]', { hasText: sidePrompt }),
      ).toHaveCount(1);
      check("Saving does not send the draft", 2, prompts().length, true);
      const inspection = await invokeIpc(page, "agent-runtime:session:inspect", {
        sessionId: savedId,
      });
      check(
        "The saved chat retains the side chat Agent settings",
        sideInspection.thread.modelSelection,
        inspection.thread.modelSelection,
        true,
      );
      const savedConversation = await invokeIpc(page, "agent-runtime:session:read", {
        sessionId: savedId,
      });
      const savedRunBaseline = savedConversation.snapshot.projection.runs.length;
      check(
        "The saved chat is ordinary",
        null,
        savedConversation.snapshot.projection.thread.sideChat ?? null,
        true,
      );
      const sidebar = page.locator(
        `[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id="${saved?.executionRef?.threadId}"]`,
      );
      await expect(sidebar).toBeVisible();
      await expect(sidebar).toHaveAccessibleName(sidePrompt);
      checkSavedTitle(
        "The saved sidebar row retains the first message title",
        await sidebar.getAttribute("data-app-action-sidebar-thread-title"),
      );
      check("The saved chat appears in the sidebar", 1, await sidebar.count(), true);
      await expect.poll(() => invokeIpc(page!, "project-sessions:get", sideId)).toBeNull();
      check(
        "The temporary side Session is discarded after save",
        null,
        await invokeIpc(page, "project-sessions:get", sideId),
        true,
      );
      await expect(page.getByRole("dialog", { name: "Close side chat?", exact: true })).toHaveCount(
        0,
      );
      if (kind === "codex") {
        await expect
          .poll(
            () =>
              JSON.parse(fs.readFileSync(path.join(fixture, "codex-state.json"), "utf8")).threads[
                sideNativeId!
              ],
          )
          .toBeUndefined();
        check(
          "The ephemeral native history is gone before continuation",
          false,
          Object.hasOwn(
            JSON.parse(fs.readFileSync(path.join(fixture, "codex-state.json"), "utf8")).threads,
            sideNativeId!,
          ),
          true,
        );
      }
      await savedComposer.press("Enter");
      await expect.poll(() => prompts().length, { timeout: 30_000 }).toBe(3);
      await expect
        .poll(
          async () =>
            (
              await invokeIpc(page!, "agent-runtime:session:read", { sessionId: savedId! })
            ).snapshot.projection.runs.at(-1)?.status,
          { timeout: 30_000 },
        )
        .toBe("completed");
      const firstSavedPrompt = prompts().at(-1);
      const inherited =
        JSON.stringify(firstSavedPrompt?.priorItems ?? firstSavedPrompt?.priorPromptTexts) +
        promptText(firstSavedPrompt);
      check(
        "The saved chat still knows the captured launch codename",
        true,
        inherited.includes("ORCHID"),
        true,
      );
      check("The saved chat retains its own checklist", true, inherited.includes("SCARLET"), true);
      check(
        "The transferred draft sends unchanged",
        true,
        promptText(firstSavedPrompt).includes(draft),
        true,
      );
      check(
        "The saved chat no longer uses side-only prompt policy",
        false,
        promptText(firstSavedPrompt).includes("Side conversation boundary."),
        true,
      );
      check(
        "The recorded interaction reports no renderer errors",
        "",
        await readRendererErrors(),
        true,
      );
      check("Saving reports no error notifications", [], await saveAlerts.read(), true);
      await saveAlerts.dispose();
      saveAlerts = undefined;
      if (recording) {
        await page.waitForTimeout(1000);
        await page.screencast.stop();
        recording = false;
        check(
          "The native recording is non-empty",
          true,
          fs.statSync(path.join(artifacts, "review.webm")).size > 0,
        );
      }

      await page
        .locator(
          `[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id="${source.executionRef.threadId}"]`,
        )
        .click();
      await expect.poll(() => visibleSessionId(page!)).toBe(sourceId);
      const sourceSideTabs = page.locator('[data-panel-tab-id^="sidechat-session:"]');
      await expect(sourceSideTabs).toHaveCount(0);
      check(
        "Reopening the source does not revive the saved side tab",
        0,
        await sourceSideTabs.count(),
      );
      await sidebar.click();
      await expect.poll(() => visibleSessionId(page!)).toBe(savedId);

      // A page recorder cannot span replacement Electron pages; restart assertions are unrecorded.
      await harness.stopElectron();
      page = await harness.launch();
      readRendererErrors = captureRendererErrors(page);
      await harness.waitForApplicationReady();
      await expect.poll(() => visibleSessionId(page!), { timeout: 30_000 }).toBe(savedId);
      checkSavedTitle(
        "The saved title survives restart",
        (await invokeIpc(page, "project-sessions:get", savedId))?.displayTitle,
      );
      const restored = page.locator(`[data-workbench-scene-owner="session:${savedId}"]`);
      await expect(
        restored.locator('[data-user-message-bubble="true"]', { hasText: sidePrompt }),
      ).toHaveCount(1);
      await expect(
        restored.locator('[data-user-message-bubble="true"]', { hasText: draft }),
      ).toHaveCount(1);
      check(
        "The saved execution survives restart",
        savedRunBaseline + 1,
        (await invokeIpc(page, "agent-runtime:session:read", { sessionId: savedId })).snapshot
          .projection.runs.length,
      );
      await send(
        restored.locator('[data-codex-composer="true"]:visible').first(),
        savedId,
        followUp,
      );
      const continuation = prompts().at(-1);
      const continuationHistory =
        JSON.stringify(continuation?.priorItems ?? continuation?.priorPromptTexts) +
        promptText(continuation);
      check(
        "Restart retains captured source context",
        true,
        continuationHistory.includes("ORCHID"),
      );
      check("Restart retains side-chat work", true, continuationHistory.includes("SCARLET"));
      check(
        "Restart retains the transferred draft turn",
        true,
        continuationHistory.includes(draft),
      );
      check(
        "Saved continuation uses an independent native conversation",
        true,
        (continuation?.threadId ?? continuation?.sessionId) !== sideNativeId,
      );
      check(
        "Saving leaves the source transcript unchanged",
        sourceRuns,
        (await invokeIpc(page, "agent-runtime:session:read", { sessionId: sourceId })).snapshot
          .projection.runs,
      );
      check(
        "The saved chat continues after restart",
        savedRunBaseline + 2,
        (await invokeIpc(page, "agent-runtime:session:read", { sessionId: savedId })).snapshot
          .projection.runs.length,
      );
      checkSavedTitle(
        "Later saved messages retain the original side title",
        (await invokeIpc(page, "project-sessions:get", savedId))?.displayTitle,
      );
      check("The renderer reports no errors", "", await readRendererErrors());
      if (kind === "codex")
        await page.screenshot({ path: path.join(artifacts, "final.png"), animations: "disabled" });
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
      if (recording && page && !page.isClosed()) await page.screencast.stop();
      await saveAlerts?.dispose().catch(() => undefined);
      if (titleEvidence) {
        fs.mkdirSync(titleEvidence, { recursive: true });
        fs.writeFileSync(
          path.join(titleEvidence, `${kind}-saved-title.json`),
          JSON.stringify(
            { status: passed ? "passed" : "failed", provider: kind, claims: savedTitleClaims },
            null,
            2,
          ),
        );
      }
      if (kind === "codex") {
        fs.mkdirSync(artifacts, { recursive: true });
        fs.writeFileSync(
          path.join(artifacts, "result.json"),
          JSON.stringify(
            {
              status: passed ? "passed" : "failed",
              fixture: "side-chat-save/native-peers-v1",
              provider: kind,
              sourceSessionId: sourceId,
              savedSessionId: savedId,
              claims,
            },
            null,
            2,
          ),
        );
        fs.writeFileSync(
          path.join(artifacts, "README.md"),
          `# Save a side chat as an independent chat\n\nStatus: ${passed ? "passed" : "failed"}.\n\nThe native recording begins after a source chat and its side chat are seeded. It shows the Side chat actions menu, Save as chat, the saved chat in the same Project, the transferred unsent draft, and that draft's completed turn.\n\nReopening the source without reviving its side tab, Electron restart, and the next context-preserving Send are executable assertions after recording, because the native page recorder cannot span replacement pages. final.png captures the settled chat after that restart and continuation.\n\nresult.json contains exact expected and actual values for each claim; recorded marks claims exercised during the video. Native provider peers exercise the production Electron, Main, Runtime and native SDK/protocol boundaries without real user data or paid model calls.\n`,
        );
      }
      await testInfo.attach(`${kind}-renderer-errors`, {
        body: await readRendererErrors(),
        contentType: "text/plain",
      });
      await testInfo.attach(`${kind}-runtime.log`, {
        body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile, 100_000)),
        contentType: "text/plain",
      });
      await testInfo.attach(`${kind}-native.jsonl`, {
        body: fs.existsSync(log) ? fs.readFileSync(log) : Buffer.from(""),
        contentType: "text/plain",
      });
      await harness.close();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}
