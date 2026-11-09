import { expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { invokeIpc } from "./support/editor-scenario";
import { openNewChatDraft } from "./support/new-chat-draft";
import {
  readRuntimeConversation,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";

interface ObservedNotification {
  readonly title: string;
  readonly body: string;
  readonly hasReply: boolean;
  readonly replyPlaceholder: string;
}

type NotificationObserver = typeof globalThis & {
  __notificationEvidence: {
    payload: ObservedNotification;
    instance: Electron.Notification;
  }[];
  __badgeCounts: number[];
};

/** Observe the actual Electron payload and native callbacks without sending an OS alert. */
async function observeNotifications(application: ElectronApplication): Promise<void> {
  await application.evaluate(({ Notification }, repositoryRoot) => {
    const require = process
      .getBuiltinModule("module")
      .createRequire(`${repositoryRoot}/package.json`);
    const bridgePath = require.resolve(
      `${repositoryRoot}/.generated/notifications-runtime/${process.arch}/nodex-notifications.node`,
    );
    require(bridgePath);
    const cached = require.cache[bridgePath];
    if (!cached) throw new Error("Native permission bridge did not enter the module cache");
    const scope = globalThis as NotificationObserver;
    scope.__notificationEvidence = [];
    scope.__badgeCounts = [];
    // The isolated scenario supplies authorization; the real notification policy still runs.
    cached.exports = {
      readAuthorization: async () => "authorized",
      requestAuthorization: async () => "authorized",
      setBadgeCount: (count: number) => {
        scope.__badgeCounts.push(count);
      },
    };
    Notification.isSupported = () => true;
    Notification.prototype.show = function () {
      scope.__notificationEvidence.push({
        payload: {
          title: this.title,
          body: this.body,
          hasReply: this.hasReply,
          replyPlaceholder: this.replyPlaceholder,
        },
        instance: this,
      });
      this.emit("show", {});
    };
    Notification.prototype.close = function () {
      this.emit("close", {});
    };
  }, process.cwd());
}

/** The app icon badge as Nodex last set it, or null before this observer saw a change. */
const readBadge = (application: ElectronApplication) =>
  application.evaluate(() => (globalThis as NotificationObserver).__badgeCounts.at(-1) ?? null);

const readNotifications = (application: ElectronApplication) =>
  application.evaluate(() =>
    (globalThis as NotificationObserver).__notificationEvidence.map((entry) => entry.payload),
  );

function prepareNotificationWireObserver(testInfo: TestInfo) {
  const wireLog = testInfo.outputPath("notification-wire.jsonl");
  const nodeLauncher = testInfo.outputPath("notification-node");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.mkdirSync(path.dirname(nodeLauncher), { recursive: true });
  fs.writeFileSync(
    nodeLauncher,
    `#!/bin/sh\nexec ${quote(process.execPath)} --require ${quote(path.join(process.cwd(), "tests/e2e/fixtures/agent-runtime-wire-observer.cjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  return { wireLog, nodeLauncher };
}

async function showObservedPayload(page: Page, payload: ObservedNotification): Promise<void> {
  await page.evaluate((notification) => {
    document.querySelector("#notification-evidence")?.remove();
    const panel = document.createElement("aside");
    panel.id = "notification-evidence";
    panel.style.cssText =
      "position:fixed;right:24px;top:70px;width:380px;z-index:2147483647;padding:20px;" +
      "background:#f9fafb;color:#17202a;border:1px solid #a8b3bd;border-radius:12px;" +
      "box-shadow:0 12px 30px #0002;font:14px/1.6 ui-sans-serif,system-ui;";
    const source = document.createElement("div");
    source.textContent = "E2E observer · Electron Notification.show";
    source.style.cssText = "font-size:11px;color:#536573;margin-bottom:10px";
    const title = document.createElement("strong");
    title.textContent = notification.title;
    const body = document.createElement("p");
    body.textContent = notification.body;
    body.style.cssText = "margin:6px 0 16px;white-space:pre-wrap";
    const open = document.createElement("button");
    open.textContent = "Open notification";
    open.style.cssText =
      "padding:6px 12px;border:1px solid #536573;border-radius:6px;background:white;cursor:pointer";
    open.addEventListener(
      "click",
      () =>
        void (
          window as typeof window & { openObservedNotification: () => Promise<void> }
        ).openObservedNotification(),
    );
    panel.append(source, title, body, open);
    document.body.append(panel);
  }, payload);
}

test("completion notifications show the ended Run's reply and open its Session", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const artifacts =
    process.env.NODEX_NOTIFICATION_ARTIFACT_DIR ?? testInfo.outputPath("notification-review");
  fs.mkdirSync(artifacts, { recursive: true });
  const title = "Review the notification content and summarize the result.";
  const reply =
    "## Review complete\n\n**通知内容已更新。**\n\n- Preserved the agent response.\n\n```ts\nconst reply_count = 1;\n```\n\n[Open the report](https://example.test/report).";
  const expectedBody =
    "Review complete 通知内容已更新。 Preserved the agent response. const reply_count = 1; Open the report.";
  const claims: { name: string; expected: unknown; actual: unknown }[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  const { wireLog, nodeLauncher } = prepareNotificationWireObserver(testInfo);
  const replyPath = testInfo.outputPath("notification-reply.md");
  fs.writeFileSync(replyPath, reply);
  const harness = await ElectronScenarioHarness.create({
    label: "desktop-notification-content",
    isolateHostDirectories: true,
    environment: {
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
      NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: nodeLauncher,
      NODEX_TEST_AGENT_RUNTIME_WIRE_LOG: wireLog,
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "5000",
      NODEX_FAKE_CODEX_FINAL_REPLY_PATH: replyPath,
    },
  });
  let recording: Page | null = null;
  let status: "passed" | "failed" = "failed";
  let failure: string | null = null;
  try {
    const page = await harness.launch();
    await observeNotifications(harness.application);
    await page.setViewportSize({ width: 1280, height: 800 });
    await invokeIpc(page, "settings:thread-notifications:update", {
      turnMode: "always",
      questionsEnabled: true,
    });
    await invokeIpc(page, "agent-runtime:providers:read", { refresh: true });
    const scene = await openNewChatDraft(page);
    const owner = await scene.getAttribute("data-workbench-scene-owner");
    const sessionId = owner?.slice("session:".length);
    if (!sessionId) throw new Error("Scenario draft has no Session identity");
    await page.exposeFunction("openObservedNotification", async () => {
      await harness.application.evaluate(() => {
        const entry = (globalThis as NotificationObserver).__notificationEvidence[0];
        if (!entry) throw new Error("No captured notification to open");
        entry.instance.emit("click", {});
      });
    });
    const notice = page.getByRole("alert").filter({ hasText: "Global dictation is ready." });
    await notice.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
    if (await notice.isVisible())
      await notice.getByRole("button", { name: "Dismiss notification" }).click();
    await page.screencast.start({
      path: path.join(artifacts, "review.webm"),
      size: { width: 1280, height: 800 },
    });
    await page.screencast.showActions({ position: "bottom", style: { title: "font-size: 14px" } });
    recording = page;
    const composer = scene.locator('[data-codex-composer="true"]').first();
    await composer.fill(title);
    await composer.press("Enter");
    await expect
      .poll(async () => (await invokeIpc(page, "project-sessions:get", sessionId))?.executionRef)
      .toBeTruthy();
    const session = await invokeIpc(page, "project-sessions:get", sessionId);
    const threadId = session?.executionRef?.threadId;
    if (!threadId) throw new Error("The submitted Session has no root Thread");
    await openNewChatDraft(page);
    await page.mouse.move(650, 600);
    await waitForRuntimeCompletedAgentTurn(page, { sessionId, threadId });
    const completed = await readRuntimeConversation(page, { sessionId, threadId });
    fs.writeFileSync(
      path.join(artifacts, "runtime-outcome.json"),
      JSON.stringify(completed, null, 2),
    );
    await expect.poll(() => readNotifications(harness.application)).toHaveLength(1);
    const notification = (await readNotifications(harness.application))[0]!;
    const completedSession = await invokeIpc(page, "project-sessions:get", sessionId);
    expect(completedSession?.displayTitle).toBeTruthy();
    claim(
      "Notification title identifies its Session",
      completedSession?.displayTitle,
      notification.title,
    );
    claim(
      "Notification body contains the final reply as plain text",
      expectedBody,
      notification.body,
    );
    claim("Completion offers a native follow-up reply", true, notification.hasReply);
    await expect.poll(() => readBadge(harness.application)).toBe(1);
    claim("The app badge counts the unread chat", 1, await readBadge(harness.application));
    await showObservedPayload(page, notification);
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "Open notification", exact: true }).click();
    const returnedScene = page.locator(`[data-workbench-scene-owner="session:${sessionId}"]`);
    await expect(returnedScene).toBeVisible();
    await expect(returnedScene.getByText("通知内容已更新。", { exact: true })).toBeVisible();
    claim("Click returns to the completed Session", true, await returnedScene.isVisible());
    await expect.poll(() => readBadge(harness.application)).toBe(0);
    claim("Reading the chat clears the app badge", 0, await readBadge(harness.application));
    await harness.application.evaluate(() => {
      (globalThis as NotificationObserver).__notificationEvidence[0]!.instance.emit("click", {});
    });
    await page.reload();
    await harness.waitForApplicationReady();
    await page.locator(`[data-app-action-sidebar-thread-id="${threadId}"]`).click();
    await page.mouse.move(650, 600);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(returnedScene).toBeVisible();
    await waitForRuntimeCompletedAgentTurn(page, { sessionId, threadId });
    claim(
      "History hydration does not repeat completion",
      1,
      (await readNotifications(harness.application)).length,
    );
    await showObservedPayload(page, notification);
    await page
      .getByRole("button", { name: "Open notification", exact: true })
      .evaluate((button) => {
        button.textContent = "Verified · reply preserved and Session opened";
        (button as HTMLButtonElement).disabled = true;
      });
    await page.screenshot({ path: path.join(artifacts, "final.png") });
    await page.waitForTimeout(1_500);
    status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (recording) await recording.screencast.stop();
    fs.writeFileSync(
      path.join(artifacts, "result.json"),
      JSON.stringify(
        { status, scenario: "desktop-notification-content", claims, failure },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(artifacts, "README.md"),
      `# Desktop notification content\n\nStatus: **${status}**\n\n` +
        "A fresh disposable Profile runs a local scripted Codex peer through the production Agent Runtime. " +
        "The recording sends a prompt, leaves its Session, observes completion, and opens the same Session through the native notification callback.\n\n" +
        "The labeled E2E observer displays the actual payload at Electron Notification.show. " +
        "OS delivery and authorization are replaced only inside this test process; this is not a recording of the macOS notification banner.\n\n" +
        claims.map((entry) => `- ${entry.name}: ${JSON.stringify(entry.actual)}\n`).join("") +
        "\nExact expected and actual values are in result.json.\n",
    );
    await testInfo.attach("notification-runtime.log", {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile, 100_000)),
      contentType: "text/plain",
    });
    if (fs.existsSync(wireLog))
      fs.copyFileSync(wireLog, path.join(artifacts, "runtime-wire.jsonl"));
    await harness.close();
  }
});

test("side chat notifications reopen its tab in the source Session and reply to the side chat", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const artifacts =
    process.env.NODEX_SIDE_CHAT_NOTIFICATION_ARTIFACT_DIR ??
    testInfo.outputPath("side-chat-notification-review");
  fs.mkdirSync(artifacts, { recursive: true });
  const { wireLog, nodeLauncher } = prepareNotificationWireObserver(testInfo);
  const fixture = testInfo.outputPath("side-chat-peer");
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, "plan.json"), "{}");
  const codex = path.join(fixture, "codex");
  const peer = fs
    .readFileSync("scripts/scenarios/runtime/cross-provider-peer.mjs", "utf8")
    .replace(/^#![^\n]*\n/u, "");
  fs.writeFileSync(codex, `#!${process.execPath}\n${peer}`, { mode: 0o755 });
  const releaseFile = path.join(fixture, "release-side-reply");
  const sidePrompt = "Verify side-chat notification navigation";
  const reply = "Codex child report";
  const harness = await ElectronScenarioHarness.create({
    label: "side-chat-notification-navigation",
    isolateHostDirectories: true,
    prepareAgentRuntime: false,
    environment: {
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: nodeLauncher,
      NODEX_TEST_AGENT_RUNTIME_WIRE_LOG: wireLog,
      NODEX_TEST_CROSS_PROVIDER_HOME: fixture,
      NODEX_TEST_NATIVE_HOLD_PROMPT: sidePrompt,
      NODEX_TEST_NATIVE_RELEASE_FILE: releaseFile,
    },
  });
  // This peer supports native forks and holds replies until the renderer has left the source.
  prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, codex);
  let page: Page | undefined;
  try {
    page = await harness.launch();
    await observeNotifications(harness.application);
    await page.setViewportSize({ width: 1440, height: 960 });
    await invokeIpc(page, "settings:thread-notifications:update", {
      turnMode: "always",
      questionsEnabled: true,
    });
    await invokeIpc(page, "agent-runtime:providers:read", { refresh: true });
    const sourceScene = await openNewChatDraft(page);
    const owner = await sourceScene.getAttribute("data-workbench-scene-owner");
    if (!owner?.startsWith("session:")) throw new Error("The source chat has no Session");
    const sourceId = owner.slice("session:".length);
    const sourceComposer = sourceScene.locator('[data-codex-composer="true"]:visible').first();
    await sourceComposer.fill("Prepare a source chat for notification navigation");
    await sourceComposer.press("Enter");
    await expect
      .poll(async () => (await invokeIpc(page!, "project-sessions:get", sourceId))?.executionRef)
      .toBeTruthy();
    const source = await invokeIpc(page, "project-sessions:get", sourceId);
    if (!source?.executionRef) throw new Error("The source chat has no execution binding");
    await waitForRuntimeCompletedAgentTurn(page, {
      sessionId: sourceId,
      threadId: source.executionRef.threadId,
    });
    await expect(sourceScene.getByText(reply, { exact: true })).toBeVisible();
    await expect.poll(() => readNotifications(harness.application)).toHaveLength(1);
    expect((await readNotifications(harness.application))[0]?.title).toBe(source.displayTitle);

    await sourceComposer.fill(`/side ${sidePrompt}`);
    await sourceComposer.press("Enter");
    // Panel tab headers live in the shell banner, outside the source Scene.
    const initialTab = page.locator("[data-panel-tab-id]").filter({
      has: page.getByRole("tab", { name: sidePrompt, exact: true }),
    });
    await expect(initialTab).toBeVisible({ timeout: 30_000 });
    const tabId = await initialTab.getAttribute("data-panel-tab-id");
    if (!tabId) throw new Error("The side chat has no surface identity");
    // The tab opens at once; its Session is created behind it.
    await expect
      .poll(async () => (await invokeIpc(page!, "project-sessions:side-chats", sourceId)).items, {
        timeout: 30_000,
      })
      .toHaveLength(1);
    const attached = await invokeIpc(page, "project-sessions:side-chats", sourceId);
    const sideId = attached.items[0]?.sessionId;
    if (!sideId) throw new Error("The side chat has no bound Session");
    const side = await invokeIpc(page, "project-sessions:get", sideId);
    if (!side?.executionRef) throw new Error("The side chat has no execution binding");
    expect(sideId).not.toBe(sourceId);
    const sideTab = page.locator(`[data-panel-tab-id="${tabId}"]`).getByRole("tab");
    const sidePanel = page.locator(`[role="tabpanel"][data-tab-id="${tabId}"]`);
    const sideComposer = sidePanel.locator('[data-codex-composer="true"]');
    const readSideRuns = async () =>
      (await invokeIpc(page!, "agent-runtime:session:read", { sessionId: sideId })).snapshot
        .projection.runs;
    await expect.poll(async () => (await readSideRuns()).at(-1)?.status).toBe("running");
    // The opening message is sent, not left behind as a draft to send again.
    await expect(sideComposer).toHaveText("");
    const sideTitle = (await invokeIpc(page, "project-sessions:get", sideId))?.displayTitle;
    expect(sideTitle).toBe(sidePrompt);
    expect(sideTitle).not.toBe(source.displayTitle);
    // Leave another tab selected so the first click must also change panel selection.
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(sideTab).toHaveAttribute("aria-selected", "false");

    const readSourceRuns = async () =>
      (await invokeIpc(page!, "agent-runtime:session:read", { sessionId: sourceId })).snapshot
        .projection.runs;
    const sourceRunCount = (await readSourceRuns()).length;
    const openCompletion = async (
      sideRunCount: number,
      screenshot: string,
      inlineReply: string | null,
    ) => {
      await openNewChatDraft(page!);
      await expect(sourceScene).toBeHidden();
      expect((await readSideRuns()).at(-1)?.status).toBe("running");
      fs.writeFileSync(releaseFile, "release");
      await waitForRuntimeCompletedAgentTurn(page!, {
        sessionId: sideId,
        threadId: side.executionRef!.threadId,
      });
      await expect
        .poll(async () =>
          (await readNotifications(harness.application)).filter(
            (entry) => entry.title === sideTitle,
          ),
        )
        .toHaveLength(sideRunCount);
      const notifications = await readNotifications(harness.application);
      expect(notifications).toHaveLength(1 + sideRunCount);
      const notificationIndex = notifications.findLastIndex((entry) => entry.title === sideTitle);
      expect(notificationIndex).toBe(sideRunCount);
      expect(notifications[notificationIndex]).toMatchObject({
        title: sideTitle,
        body: reply,
        hasReply: true,
      });
      await harness.application.evaluate(
        (_electron, { index, text }) => {
          const entry = (globalThis as NotificationObserver).__notificationEvidence[index];
          if (!entry) throw new Error("The side chat has no captured completion notification");
          if (text === null) entry.instance.emit("click", {});
          else entry.instance.emit("reply", {}, text);
        },
        { index: notificationIndex, text: inlineReply },
      );
      await expect(sourceScene).toBeVisible();
      await expect(page!.locator(`[data-workbench-scene-owner="session:${sideId}"]`)).toHaveCount(
        0,
      );
      await expect(sideTab).toBeVisible();
      await expect(sideTab).toHaveAttribute("aria-selected", "true");
      await expect(sidePanel).toBeVisible();
      // Remounting the side chat does not resurrect or resend its opening message.
      await expect(sideComposer).toHaveText("");
      if (inlineReply !== null) {
        // The reply is a follow-up in the side chat; its source conversation is untouched.
        await expect(sidePanel.getByText(inlineReply, { exact: true })).toBeVisible();
        await expect
          .poll(async () => (await readSideRuns()).map((run) => run.status))
          .toEqual(Array.from({ length: sideRunCount + 1 }, () => "completed"));
        expect(await readSourceRuns()).toHaveLength(sourceRunCount);
      }
      const replies = sideRunCount + (inlineReply === null ? 0 : 1);
      await expect(sidePanel.getByText(reply, { exact: true })).toHaveCount(replies);
      await expect(sidePanel.getByText(reply, { exact: true }).last()).toBeVisible();
      await page!.mouse.move(720, 700);
      await page!.screenshot({ path: path.join(artifacts, screenshot), animations: "disabled" });
      await testInfo.attach(screenshot, {
        path: path.join(artifacts, screenshot),
        contentType: "image/png",
      });
    };

    await openCompletion(1, "existing-side-chat-tab.png", null);
    fs.rmSync(releaseFile);
    await sideComposer.fill(sidePrompt);
    await sideComposer.press("Enter");
    await expect
      .poll(async () => (await readSideRuns()).map((run) => run.status))
      .toEqual(["completed", "running"]);
    await page.reload();
    await harness.waitForApplicationReady();
    // Reload restores the durable tab.
    await expect(page.locator(`[data-panel-tab-id="${tabId}"]`)).toBeVisible();
    expect((await invokeIpc(page, "project-sessions:get", sideId))?.executionRef).toEqual(
      side.executionRef,
    );
    await openCompletion(
      2,
      "restored-side-chat-tab-after-reply.png",
      "Reply from the notification",
    );
    fs.writeFileSync(
      path.join(artifacts, "side-chat-result.json"),
      JSON.stringify(
        { sourceId, sideId, notifications: await readNotifications(harness.application) },
        null,
        2,
      ),
    );
  } catch (error) {
    if (page && !page.isClosed()) {
      await testInfo.attach("side-chat-failure-state", {
        body: await page.locator("body").ariaSnapshot(),
        contentType: "text/plain",
      });
      await page.screenshot({ path: path.join(artifacts, "side-chat-failure.png") });
    }
    throw error;
  } finally {
    fs.writeFileSync(releaseFile, "release");
    await testInfo.attach("side-chat-notification-runtime.log", {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile, 100_000)),
      contentType: "text/plain",
    });
    if (fs.existsSync(wireLog))
      fs.copyFileSync(wireLog, path.join(artifacts, "side-chat-runtime-wire.jsonl"));
    await harness.close();
  }
});
