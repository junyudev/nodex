import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
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
    // The isolated scenario supplies authorization; the real notification policy still runs.
    cached.exports = {
      readAuthorization: async () => "authorized",
      requestAuthorization: async () => "authorized",
    };
    const scope = globalThis as NotificationObserver;
    scope.__notificationEvidence = [];
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

const readNotifications = (application: ElectronApplication) =>
  application.evaluate(() =>
    (globalThis as NotificationObserver).__notificationEvidence.map((entry) => entry.payload),
  );

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
  const wireLog = testInfo.outputPath("notification-wire.jsonl");
  const nodeLauncher = testInfo.outputPath("notification-node");
  const replyPath = testInfo.outputPath("notification-reply.md");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.mkdirSync(path.dirname(nodeLauncher), { recursive: true });
  fs.writeFileSync(replyPath, reply);
  fs.writeFileSync(
    nodeLauncher,
    `#!/bin/sh\nexec ${quote(process.execPath)} --require ${quote(path.join(process.cwd(), "tests/e2e/fixtures/agent-runtime-wire-observer.cjs"))} "$@"\n`,
    { mode: 0o755 },
  );
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
      annotate: { position: "bottom", fontSize: 14 },
    });
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
    await showObservedPayload(page, notification);
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "Open notification", exact: true }).click();
    const returnedScene = page.locator(`[data-workbench-scene-owner="session:${sessionId}"]`);
    await expect(returnedScene).toBeVisible();
    await expect(returnedScene.getByText("通知内容已更新。", { exact: true })).toBeVisible();
    claim("Click returns to the completed Session", true, await returnedScene.isVisible());
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
