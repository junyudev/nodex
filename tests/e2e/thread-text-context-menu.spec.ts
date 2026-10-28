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
import { buildAppFilesystemUrl } from "../../src/shared/app-protocol";

const IMAGE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMAAAABgCAIAAADEouq+AAABB0lEQVR4nO3SQQkAIADAQDtZwQr2r2IH9xDh4ALssTHXhmvjeQFfMxCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiOQAEgtjWAPttLUAAAAASUVORK5CYII=",
  "base64",
);

interface NativeMenuEvidence {
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly accelerator: string | null;
    readonly role?: string;
  }[];
  readonly context: {
    readonly selectionText: string;
    readonly isEditable: boolean;
    readonly linkURL: string;
    readonly mediaType?: string;
    readonly srcURL?: string;
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
            ...(params.mediaType === "image"
              ? { mediaType: params.mediaType, srcURL: params.srcURL }
              : {}),
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
                ...(item.role ? { role: item.role } : {}),
              }));
            if (input.actionId) {
              const action = this.getMenuItemById(input.actionId);
              if (!action?.enabled)
                throw new Error(`Native menu action ${input.actionId} is unavailable`);
              // Cocoa executes native roles outside MenuItem.click; invoking that callback
              // would only notify the renderer, so it cannot prove a native edit occurred.
              if (action.role)
                throw new Error("Inspect native roles without invoking their click callback");
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

test("native context menus preserve selected text, image actions, and file editor roles", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-thread-text-menu-"));
  const peer = path.join(fixture, "codex.mjs");
  const version = "0.145.0-alpha.15";
  fs.writeFileSync(
    peer,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("codex-cli ${version}"); process.exit(0); }\n${fs.readFileSync("tests/e2e/fixtures/codex-queue-app-server.mjs", "utf8").replace(/^#![^\n]*\n/u, "")}`,
  );
  const reply = path.join(fixture, "reply.md");
  const selectedText = "大 Bot 电脑";
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
  const imagePath = path.join(harness.profile.initialProjectsDirectory, "native-menu.png");
  const editorPath = path.join(harness.profile.initialProjectsDirectory, "native-menu.txt");
  fs.writeFileSync(imagePath, IMAGE_PNG);
  fs.writeFileSync(editorPath, "editor sentinel");
  fs.writeFileSync(
    reply,
    [
      `Copy ${selectedText} precisely from this reply.`,
      `![Context menu image](<${imagePath}>)`,
      `[Editable menu fixture](<${editorPath}>)`,
    ].join("\n\n"),
  );
  prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, peer, version);
  let inspectedPage: Page | undefined;
  const rendererErrors: string[] = [];
  try {
    const page = await harness.launch();
    inspectedPage = page;
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") rendererErrors.push(message.text());
    });
    expect(
      await harness.application.evaluate(
        ({ nativeImage }, png) =>
          nativeImage.createFromBuffer(Buffer.from(png, "base64")).getSize(),
        IMAGE_PNG.toString("base64"),
      ),
    ).toEqual({ width: 192, height: 96 });
    await page.setViewportSize({ width: 1440, height: 960 });
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
    await expect(
      response.getByText(`Copy ${selectedText} precisely from this reply.`, { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    const markdownImage = response.getByRole("img", { name: "Context menu image", exact: true });
    await expect
      .poll(() =>
        markdownImage.evaluate((element: HTMLImageElement) =>
          element.complete ? element.naturalWidth : 0,
        ),
      )
      .toBe(192);
    await expect(
      response.getByRole("button", { name: "Context menu image", exact: true }),
    ).toBeEnabled();
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

    // A plain HTML image exercises the application window's native image fallback.
    // Conversation images below use the real resource owner and their own native menu.
    const imageUrl = buildAppFilesystemUrl(imagePath);
    await page.evaluate((src) => {
      const image = document.createElement("img");
      image.src = src;
      image.alt = "Native fallback fixture";
      image.setAttribute("data-native-menu-fixture", "true");
      Object.assign(image.style, {
        position: "fixed",
        top: "100px",
        right: "24px",
        width: "192px",
        height: "96px",
        zIndex: "2147483000",
      });
      document.body.append(image);
    }, imageUrl);
    const fallbackImage = page.getByRole("img", { name: "Native fallback fixture", exact: true });
    await expect
      .poll(() =>
        fallbackImage.evaluate((element: HTMLImageElement) =>
          element.complete ? element.naturalWidth : 0,
        ),
      )
      .toBe(192);
    const clearClipboardImage = async () => {
      await harness.application.evaluate(({ clipboard }) => clipboard.clear());
      await expect
        .poll(() => harness.application.evaluate(({ clipboard }) => clipboard.has("image/png")))
        .toBe(false);
    };
    const copiedImageSize = () =>
      harness.application.evaluate(async ({ clipboard, nativeImage }) => {
        const item = (await clipboard.read()).find((entry) => entry.types.includes("image/png"));
        if (!item) return null;
        const blob = await item.getType("image/png");
        return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).getSize();
      });
    await clearClipboardImage();
    const [fallbackMenu] = await Promise.all([
      captureNativeMenu(harness.application, page, "copyImage"),
      fallbackImage.click({ button: "right" }),
    ]);
    expect(fallbackMenu.context).toMatchObject({ mediaType: "image", srcURL: imageUrl });
    expect(
      fallbackMenu.items.filter((item) => item.id !== "inspect").map((item) => item.label),
    ).toEqual([
      process.platform === "darwin"
        ? "Reveal in Finder"
        : process.platform === "win32"
          ? "Open in Explorer"
          : "Open in File Manager",
      "Copy Image",
      "Save Image As…",
      ...(process.platform !== "darwin" ? ["Select All"] : []),
    ]);
    await expect.poll(copiedImageSize).toEqual({ width: 192, height: 96 });
    await fallbackImage.evaluate((element) => element.remove());

    await markdownImage.scrollIntoViewIfNeeded();
    await expect(
      response.getByRole("button", { name: "Context menu image", exact: true }),
    ).toBeEnabled();
    await clearClipboardImage();
    const [imageMenu] = await Promise.all([
      captureNativeMenu(harness.application, page, "copy"),
      markdownImage.click({ button: "right" }),
    ]);
    expect(imageMenu.context).toBeNull();
    expect(imageMenu.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "open", label: "Open image in new tab" }),
        expect.objectContaining({ id: "copy", label: "Copy image" }),
        expect.objectContaining({ id: "download", label: "Download a copy" }),
      ]),
    );
    expect(imageMenu.items.some((item) => item.id === "copyImage" || item.id === "inspect")).toBe(
      false,
    );
    await expect.poll(copiedImageSize).toEqual({ width: 192, height: 96 });

    await response.getByRole("button", { name: "Editable menu fixture", exact: true }).click();
    const editor = page
      .locator('[data-workspace-pierre-editor="true"] [contenteditable="true"]')
      .first();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveText("editor sentinel");
    const [editorMenu] = await Promise.all([
      captureNativeMenu(harness.application, page, null),
      editor.click({ button: "right" }),
    ]);
    expect(editorMenu.items.slice(0, 6).map((item) => item.id)).toEqual([
      "file-undo",
      "file-redo",
      "file-cut",
      "file-copy",
      "file-paste",
      "file-select-all",
    ]);
    expect(editorMenu.items.slice(-4).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "file-reference:save", label: "Save as…" },
      { id: "file-reference:copy-path", label: "Copy path" },
      { id: "file-reference:copy-contents", label: "Copy file contents" },
      {
        id: "file-reference:reveal",
        label:
          process.platform === "darwin"
            ? "Reveal in Finder"
            : process.platform === "win32"
              ? "Open in Explorer"
              : "Open in File Manager",
      },
    ]);
    expect(editorMenu.items.some(({ id }) => id === "file-reference:open")).toBe(false);
    expect(
      editorMenu.items
        .filter((item) => item.role)
        .map((item) => ({ id: item.id, role: item.role })),
    ).toEqual([
      { id: "file-cut", role: "cut" },
      { id: "file-copy", role: "copy" },
      { id: "file-paste", role: "paste" },
    ]);
    await harness.application.evaluate(({ clipboard }) =>
      clipboard.writeText("file path sentinel"),
    );
    const [fileCopyMenu] = await Promise.all([
      captureNativeMenu(harness.application, page, "file-reference:copy-path"),
      editor.click({ button: "right" }),
    ]);
    await expect
      .poll(() => harness.application.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(editorPath);
    // Roles above are a native-menu structure check. Real keyboard paste separately
    // verifies the live editor's clipboard workflow without simulating a Cocoa action.
    await harness.application.evaluate(({ clipboard }) => clipboard.writeText("native paste once"));
    await editor.click();
    await editor.press("ControlOrMeta+A");
    await editor.press("ControlOrMeta+V");
    await expect(editor).toHaveText("native paste once");
    const [undoMenu] = await Promise.all([
      captureNativeMenu(harness.application, page, "file-undo"),
      editor.click({ button: "right" }),
    ]);
    expect(undoMenu.items.find((item) => item.id === "file-undo")?.enabled).toBe(true);
    await expect(editor).toHaveText("editor sentinel");

    const evidencePath = testInfo.outputPath("native-menu-evidence.json");
    fs.writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          selection: menu,
          session: sessionMenu,
          fallbackImage: fallbackMenu,
          markdownImage: imageMenu,
          editor: editorMenu,
          fileCopy: fileCopyMenu,
          undo: undoMenu,
        },
        null,
        2,
      ),
    );
    await testInfo.attach("native-chat-menus", {
      path: evidencePath,
      contentType: "application/json",
    });
  } catch (error) {
    if (inspectedPage) {
      const diagnostics = await inspectedPage
        .evaluate(async () => {
          const image = document.querySelector<HTMLImageElement>('img[alt="Context menu image"]');
          return {
            image: image?.src,
            alerts: [...document.querySelectorAll('[role="alert"], [role="status"]')].map(
              (element) => element.textContent,
            ),
          };
        })
        .catch(() => null);
      await testInfo.attach("native-menu-renderer-diagnostics", {
        body: Buffer.from(JSON.stringify({ rendererErrors, diagnostics }, null, 2)),
        contentType: "application/json",
      });
    }
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
