import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { openNewChatDraft } from "./support/new-chat-draft";
import { invokeIpc } from "./support/editor-scenario";

test("refocusing the open chat clears its unread dot without changing chats", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-thread-read-state-"));
  const codex = path.join(fixture, "codex");
  const body = fs
    .readFileSync(path.resolve("tests/e2e/fixtures/agent-runtime-cross-provider-peer.mjs"), "utf8")
    .replace(/^#![^\n]*\n/u, "");
  fs.writeFileSync(codex, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  fs.writeFileSync(path.join(fixture, "plan.json"), "{}");
  const harness = await ElectronScenarioHarness.create({
    label: "thread-read-state",
    windows: "foreground",
    prepareAgentRuntime: false,
    retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_CROSS_PROVIDER_HOME: fixture,
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, codex, "0.145.0-alpha.15");
  let page: Page | undefined;
  try {
    page = await harness.launch();
    await page.setViewportSize({ width: 1440, height: 960 });
    const ownedWindow = await harness.application.browserWindow(page);
    const scene = await openNewChatDraft(page);
    const owner = await scene.getAttribute("data-workbench-scene-owner");
    if (!owner?.startsWith("session:")) throw new Error("The chat has no Session Scene");
    const sessionId = owner.slice("session:".length);
    const readSession = () => invokeIpc(page!, "project-sessions:get", sessionId);
    const composer = scene.locator('[data-codex-composer="true"]:visible');
    await composer.fill("Hold async read-state");
    await composer.press("Enter");
    await expect(scene.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect.poll(async () => (await readSession())?.executionRef?.threadId).toBeTruthy();
    const threadId = (await readSession())!.executionRef!.threadId;
    const row = page.locator(
      `[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id="${threadId}"]`,
    );
    const unreadDot = row.locator('[data-app-action-sidebar-thread-status="unread"]');
    await expect(row).toHaveAttribute("data-app-action-sidebar-thread-active", "true");
    await expect(unreadDot).toHaveCount(0);

    // Finish through the native fixture while the same chat remains selected in a blurred window.
    await ownedWindow.evaluate((window) => window.blur());
    await expect.poll(() => ownedWindow.evaluate((window) => window.isFocused())).toBe(false);
    fs.writeFileSync(path.join(fixture, "async-release"), "release");
    await expect.poll(async () => (await readSession())?.unread, { timeout: 30_000 }).toBe(true);
    await expect(scene.getByText("Codex child report", { exact: true })).toBeVisible();
    await expect(unreadDot).toBeVisible();
    await expect(row).toHaveAttribute("data-app-action-sidebar-thread-active", "true");
    await testInfo.attach("open-chat-unread", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await harness.application.evaluate(({ app }) => app.focus({ steal: true }));
    await ownedWindow.evaluate((window) => window.focus());
    await expect.poll(() => ownedWindow.evaluate((window) => window.isFocused())).toBe(true);
    await expect.poll(async () => (await readSession())?.unread).toBe(false);
    await expect(unreadDot).toHaveCount(0);
    await expect(row).toHaveAttribute("data-app-action-sidebar-thread-active", "true");
    await expect(scene).toBeVisible();
    await testInfo.attach("open-chat-read", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await ownedWindow.dispose();
  } catch (error) {
    await testInfo.attach("thread-read-state-runtime-logs", {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile)),
      contentType: "text/plain",
    });
    const screenshot = await page?.screenshot().catch(() => null);
    if (screenshot)
      await testInfo.attach("thread-read-state-failure", {
        body: screenshot,
        contentType: "image/png",
      });
    throw error;
  } finally {
    await harness.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
