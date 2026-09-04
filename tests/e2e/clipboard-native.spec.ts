import { expect, test } from "@playwright/test";
import { _electron } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

import type { NativeClipboardBridge } from "../../src/main/platform/electron/native-clipboard";

test("enhances a browser copy without losing private formats or overwriting newer copies", async () => {
  const application = await _electron.launch({
    executablePath: process.env.NODEX_ELECTRON_CLIPBOARD_CANDIDATE,
    args: [path.join(process.cwd(), "tests/e2e/clipboard-fixture/main.cjs")],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      NODEX_CLIPBOARD_TEST_HOME: mkdtempSync(path.join(os.tmpdir(), "nodex-clipboard-test-")),
    },
  });
  try {
    if (process.env.NODEX_ELECTRON_CLIPBOARD_CANDIDATE) {
      expect(await application.evaluate(() => process.versions.electron)).toBe("44.2.0");
    }
    const page = await application.firstWindow();
    const editor = page.getByRole("textbox");
    await expect(editor).toBeVisible();
    const original = {
      "text/plain": "Original file reference 图片",
      "text/html": "<p>Original rich presentation</p>",
      "blocknote/html": "<div>Parent<div>Image A</div><div>Image B</div></div>",
      "application/x-nodex-structural-clipboard+json": '{"transportProbe":"original"}',
    };
    const copy = async (payload: typeof original) => {
      await page.evaluate((value) => {
        Object.assign(window, { copyPayload: value });
      }, payload);
      await editor.selectText();
      await page.keyboard.press("Meta+c");
    };
    const read = () =>
      application.evaluate(({ app }) =>
        (app as unknown as { clipboardBridge: NativeClipboardBridge }).clipboardBridge.read(),
      );
    const update = (generation: number, text: string, html?: string) =>
      application.evaluate(
        ({ app }, input) =>
          (app as unknown as { clipboardBridge: NativeClipboardBridge }).clipboardBridge.update(
            input.generation,
            input.text,
            input.html,
          ),
        { generation, text, html },
      );
    const paste = async () => {
      await page.evaluate(() => Object.assign(window, { pastePayload: null }));
      await editor.focus();
      await page.keyboard.press("Meta+v");
      await page.waitForFunction(() => Reflect.get(window, "pastePayload") !== null);
      return page.evaluate(() => Reflect.get(window, "pastePayload") as Record<string, string>);
    };

    await copy(original);
    const snapshot = await read();
    expect(snapshot.text).toBe(original["text/plain"]);
    expect(
      await update(snapshot.generation, "/synthetic/file.png", "<p>Resolved rich presentation</p>"),
    ).toBe("written");
    expect(await paste()).toMatchObject({
      ...original,
      "text/plain": "/synthetic/file.png",
      "text/html": "<p>Resolved rich presentation</p>",
    });

    await copy(original);
    const beforeExternal = await read();
    execFileSync("/usr/bin/pbcopy", { input: "Newer external copy" });
    expect(await update(beforeExternal.generation, "Stale text", "<p>Stale HTML</p>")).toBe(
      "superseded",
    );
    expect(await paste()).toEqual({ "text/plain": "Newer external copy" });
    expect(beforeExternal.text).toBe(original["text/plain"]);

    await copy(original);
    const beforeBrowser = await read();
    await copy({ ...original, "text/plain": "Newer browser copy" });
    expect(await update(beforeBrowser.generation, "Stale text")).toBe("superseded");
    expect((await paste())["text/plain"]).toBe("Newer browser copy");
    await expect(
      update((await read()).generation, "x".repeat(8 * 1024 * 1024 + 1)),
    ).rejects.toThrow("too_large");
    expect((await paste())["text/plain"]).toBe("Newer browser copy");
    const resourceRoot = mkdtempSync(path.join(os.tmpdir(), "nodex-clipboard-resources-"));
    const resourceFile = path.join(resourceRoot, "paste.txt");
    const resourceFolder = path.join(resourceRoot, "folder");
    writeFileSync(resourceFile, "Synthetic file");
    mkdirSync(resourceFolder);
    const urls = [resourceFile, resourceFolder].map((entry) => pathToFileURL(entry).href);
    await application.evaluate(async ({ clipboard, ClipboardItem }, fileUrls) => {
      await clipboard.write([new ClipboardItem({ "text/uri-list": fileUrls.join("\r\n") })]);
    }, urls);
    expect((await read()).fileUrls).toEqual(urls);
    await paste();
    expect(await page.evaluate(() => Reflect.get(window, "pasteFiles"))).toEqual([
      { name: "paste.txt", type: "text/plain", size: 14 },
      { name: "folder", type: "", size: expect.any(Number) },
    ]);
  } finally {
    // The OS clipboard is shared. Restoring an old snapshot could overwrite another app's copy.
    await application.close();
  }
});
