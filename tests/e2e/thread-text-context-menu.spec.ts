import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication } from "playwright";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { invokeIpc } from "./support/editor-scenario";
import { openNewChatDraft } from "./support/new-chat-draft";

interface NativeMenuEvidence {
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly accelerator: string | null;
  }[];
  readonly context: {
    readonly selectionText: string;
    readonly isEditable: boolean;
    readonly linkURL: string;
  } | null;
}

/** Exercise the installed MenuItem callback after Chromium raises its native context-menu event. */
const captureNativeMenu = (
  application: ElectronApplication,
  page: Page,
  actionId: string | null,
): Promise<NativeMenuEvidence> =>
  application.evaluate(
    ({ BrowserWindow, Menu }, input) =>
      new Promise<NativeMenuEvidence>((resolve, reject) => {
        const window = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.webContents.getURL() === input.url,
        );
        if (!window) throw new Error("The chat's application window is missing");
        let context: NativeMenuEvidence["context"] = null;
        const observeContext = (_event: Electron.Event, params: Electron.ContextMenuParams) => {
          context = {
            selectionText: params.selectionText,
            isEditable: params.isEditable,
            linkURL: params.linkURL,
          };
        };
        window.webContents.prependOnceListener("context-menu", observeContext);
        const originalPopup = Menu.prototype.popup;
        const restore = () => {
          Menu.prototype.popup = originalPopup;
          window.webContents.removeListener("context-menu", observeContext);
        };
        const timeout = setTimeout(() => {
          restore();
          reject(new Error("Right-clicking the chat did not open a native context menu"));
        }, 15_000);
        Menu.prototype.popup = function (options) {
          restore();
          clearTimeout(timeout);
          try {
            const items = this.items
              .filter((item) => item.visible && item.type !== "separator")
              .map((item) => ({
                id: item.id,
                label: item.label.replaceAll("&", ""),
                enabled: item.enabled,
                accelerator: item.accelerator ?? null,
              }));
            if (input.actionId) {
              const action = this.getMenuItemById(input.actionId);
              if (!action?.enabled)
                throw new Error(`Native menu action ${input.actionId} is unavailable`);
              Reflect.apply(action.click, action, [action, window, {}]);
            }
            options?.callback?.();
            resolve({ items, context });
          } catch (error) {
            options?.callback?.();
            reject(error);
          }
        };
      }),
    { url: page.url(), actionId },
  );

async function selectText(page: Page, response: Locator, text: string) {
  await response.scrollIntoViewIfNeeded();
  const points = await response.evaluate((element, selectionText) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent?.includes(selectionText)) break;
      node = walker.nextNode();
    }
    if (!node) throw new Error("The reply does not contain the requested selection");
    const start = node.textContent!.indexOf(selectionText);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 1);
    const first = range.getBoundingClientRect();
    range.setStart(node, start + selectionText.length - 1);
    range.setEnd(node, start + selectionText.length);
    const last = range.getBoundingClientRect();
    return {
      start: { x: first.left + 1, y: first.y + first.height / 2 },
      end: { x: last.right - 1, y: last.y + last.height / 2 },
    };
  }, text);
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
  } finally {
    await page.mouse.up();
  }
  return { x: (points.start.x + points.end.x) / 2, y: points.start.y };
}

test("selected chat text opens the native menu and copies only the selection", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-thread-text-menu-"));
  const peer = path.join(fixture, "codex.mjs");
  const version = "0.145.0-alpha.15";
  fs.writeFileSync(
    peer,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("codex-cli ${version}"); process.exit(0); }\n${fs.readFileSync("tests/e2e/fixtures/codex-queue-app-server.mjs", "utf8").replace(/^#![^\n]*\n/u, "")}`,
  );
  const reply = path.join(fixture, "reply.md");
  const selectedText = "大 Bot 电脑";
  fs.writeFileSync(reply, `Copy ${selectedText} precisely from this reply.`);
  const harness = await ElectronScenarioHarness.create({
    label: "thread-text-context-menu",
    prepareAgentRuntime: false,
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_STATE_PATH: path.join(fixture, "state.json"),
      NODEX_FAKE_CODEX_LOG_PATH: path.join(fixture, "provider.jsonl"),
      NODEX_FAKE_CODEX_FINAL_REPLY_PATH: reply,
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, peer, version);
  try {
    const page = await harness.launch();
    await harness.waitForApplicationReady();
    await invokeIpc(page, "agent-runtime:providers:read", { refresh: true });
    const scene = await openNewChatDraft(page);
    const owner = await scene.getAttribute("data-workbench-scene-owner");
    if (!owner?.startsWith("session:")) throw new Error("The chat has no Session Scene");
    const sessionId = owner.slice("session:".length);
    const composer = scene.locator('[data-codex-composer="true"]').first();
    await composer.fill("Give me a reply to select.");
    await composer.press("Enter");
    const response = scene.locator("[data-response-annotation-target] .codex-markdown").first();
    await expect(response).toHaveText(`Copy ${selectedText} precisely from this reply.`, {
      timeout: 30_000,
    });
    await harness.application.evaluate(({ clipboard }) =>
      clipboard.writeText("selection sentinel"),
    );
    const point = await selectText(page, response, selectedText);
    await expect
      .poll(() => page.evaluate(() => document.getSelection()?.toString()))
      .toBe(selectedText);
    const [menu] = await Promise.all([
      captureNativeMenu(harness.application, page, "copy"),
      page.mouse.click(point.x, point.y, { button: "right" }),
    ]);
    expect(menu.context).toEqual({ selectionText: selectedText, isEditable: false, linkURL: "" });
    expect(menu.items.filter((item) => item.id !== "inspect")).toEqual([
      ...(process.platform === "darwin"
        ? [
            {
              id: "lookUpSelection",
              label: `Look Up “${selectedText}”`,
              enabled: true,
              accelerator: null,
            },
          ]
        : []),
      { id: "searchWithGoogle", label: "Search with Google", enabled: true, accelerator: null },
      { id: "copy", label: "Copy", enabled: true, accelerator: "CmdOrCtrl+C" },
      ...(process.platform !== "darwin"
        ? [{ id: "selectAll", label: "Select All", enabled: true, accelerator: null }]
        : []),
    ]);
    await expect
      .poll(() => harness.application.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(selectedText);

    // Renderer-owned Session menus must continue to take precedence over the text fallback.
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    const session = await invokeIpc(page, "project-sessions:get", sessionId);
    const threadId = session?.executionRef?.threadId;
    if (!threadId) throw new Error("The completed Session has no execution Thread");
    const row = page.locator(`[data-app-action-sidebar-thread-id="${threadId}"]`);
    await expect(row).toBeVisible();
    const [sessionMenu] = await Promise.all([
      captureNativeMenu(harness.application, page, null),
      row.click({ button: "right" }),
    ]);
    expect(sessionMenu.items.some((item) => item.id === "session.rename")).toBe(true);
    expect(sessionMenu.items.some((item) => item.id === "copy" || item.id === "inspect")).toBe(
      false,
    );
    await testInfo.attach("native-chat-menus", {
      body: Buffer.from(JSON.stringify({ selection: menu, session: sessionMenu }, null, 2)),
      contentType: "application/json",
    });
  } catch (error) {
    await testInfo.attach("thread-text-menu-runtime-logs", {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile)),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await harness.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
