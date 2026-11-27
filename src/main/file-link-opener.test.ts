import { describe, expect, test, vi } from "vite-plus/test";
import { pathToFileURL } from "node:url";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  utimes,
  rm,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import {
  buildTextMateUrl,
  formatOpenFileLocation,
  normalizeFileLinkPosition,
  resolveDirectoryOpenPath,
} from "./file-link-launch-plan";
import {
  discoverToolboxExecutables,
  listAvailableFileLinkOpeners,
  shouldPreferFileManagerForTarget,
} from "./file-link-opener";
import { FILE_LINK_OPENER_OPTIONS } from "../shared/file-link-openers";
import type { Actions } from "electron-context-menu";
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { nativeContextImagePath, nativeImageContextMenuItems } from "./native-image-context-menu";
import { LatestDurableTextWriter, writeDurableJson } from "./durable-json-file";

describe("file-link-opener", () => {
  const parserPath = path.join(process.cwd(), "src/renderer/lib/markdown/parser.ts");
  const parserDirectory = path.dirname(parserPath);
  const vscodeIconPath = path.join(
    process.cwd(),
    "src/renderer/assets/open-file-targets/vscode.png",
  );

  describe("file link opener", () => {
    test("normalizes missing columns to 1 when a line number exists", () => {
      expect(
        JSON.stringify(
          normalizeFileLinkPosition({
            path: parserPath,
            line: 71,
          }),
        ),
      ).toBe(
        JSON.stringify({
          line: 71,
          column: 1,
        }),
      );
    });

    test("formats open-file locations and directory fallbacks", () => {
      const position = normalizeFileLinkPosition({
        path: parserPath,
        line: 71,
        column: 4,
      });

      expect(formatOpenFileLocation(parserPath, position)).toBe(`${parserPath}:71:4`);
      expect(resolveDirectoryOpenPath(parserPath)).toBe(parserDirectory);
    });

    test("builds TextMate URLs with line and column information", () => {
      const position = normalizeFileLinkPosition({
        path: parserPath,
        line: 71,
      });

      expect(buildTextMateUrl(parserPath, position)).toBe(
        `txmt://open/?url=${encodeURIComponent(pathToFileURL(parserPath).href)}&line=71&column=1`,
      );
    });

    test("prefers the file manager for document-like files only when the target is implicit", () => {
      expect(shouldPreferFileManagerForTarget(vscodeIconPath, "vscode", false, false)).toBe(true);
      expect(shouldPreferFileManagerForTarget(vscodeIconPath, "vscode", true, false)).toBe(false);
    });

    test("lists only supported openers that are available on this host", async () => {
      const openers = await listAvailableFileLinkOpeners();
      const supportedOpeners = new Set(FILE_LINK_OPENER_OPTIONS.map((option) => option.id));

      expect(new Set(openers).size).toBe(openers.length);
      expect(openers.every((opener) => supportedOpeners.has(opener))).toBe(true);
      if (process.platform === "darwin") expect(openers).toContain("fileManager");
    });
  });

  test("Toolbox discovery selects the newest executable without following directory cycles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nodex-toolbox-"));
    try {
      const old = path.join(root, "old", "Editor.app", "Contents", "MacOS", "idea");
      const latest = path.join(root, "new", "Editor.app", "Contents", "MacOS", "idea");
      for (const file of [old, latest]) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "fixture");
      }
      await utimes(old, 1, 1);
      await utimes(latest, 2, 2);
      await symlink(root, path.join(root, "loop"), "dir");
      const result = await discoverToolboxExecutables(root, ["idea", "missing"]);
      expect([...result]).toEqual([["idea", latest]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("native-image-context-menu", () => {
  test("only app filesystem image URLs expose a native reveal path", () => {
    expect(nativeContextImagePath("app://fs/@fs/Users/test/a%20b.png?x=1")).toBe(
      "/Users/test/a b.png",
    );
    expect(nativeContextImagePath("app://fs/@fs/C:/work/a.png")).toBe("C:/work/a.png");
    for (const source of [
      "file:///tmp/a.png",
      "https://example.test/@fs/a.png",
      "app://fs/host/capability",
      "app://-/@fs/tmp/a.png",
      "app://fs/@fs/%ZZ",
    ])
      expect(nativeContextImagePath(source)).toBeNull();
  });

  test("native image fallback preserves edit accelerators and limits saving to the main frame", () => {
    const cut: MenuItemConstructorOptions = { id: "cut" };
    const copy: MenuItemConstructorOptions = { id: "copy" };
    const paste: MenuItemConstructorOptions = { id: "paste" };
    const actions = {
      cut: () => cut,
      copy: () => copy,
      paste: () => paste,
      selectAll: () => ({}),
      copyImage: () => ({ id: "copyImage" }),
      saveImageAs: () => ({ id: "saveImageAs" }),
    } as unknown as Actions;
    const mainFrame = {};
    const window = { webContents: { mainFrame } } as unknown as BrowserWindow;
    const params = {
      mediaType: "image",
      hasImageContents: true,
      srcURL: "app://fs/@fs/tmp/chart.png",
      frame: mainFrame,
    } as ContextMenuParams;
    const reveal = vi.fn();
    const items = nativeImageContextMenuItems(actions, params, window, "darwin", reveal);
    expect(items.map(({ id, label }) => id ?? label)).toEqual([
      "copyImage",
      undefined,
      "Reveal in Finder",
      "saveImageAs",
    ]);
    items[2]!.click?.({} as never, window, {} as never);
    expect(reveal).toHaveBeenCalledExactlyOnceWith("/tmp/chart.png");
    expect([cut.accelerator, copy.accelerator, paste.accelerator]).toEqual([
      "CmdOrCtrl+X",
      "CmdOrCtrl+C",
      "CmdOrCtrl+V",
    ]);
    expect(
      nativeImageContextMenuItems(
        actions,
        { ...params, frame: {} } as ContextMenuParams,
        window,
        "darwin",
        reveal,
      ).map(({ id, label }) => id ?? label),
    ).toEqual(["copyImage", undefined, "Reveal in Finder"]);
    expect(
      nativeImageContextMenuItems(
        actions,
        { ...params, mediaType: "none" },
        window,
        "darwin",
        reveal,
      ),
    ).toEqual([]);
  });
});

describe("durable-json-file", () => {
  test("publishes and replaces restart-readable JSON without staging leftovers", async () => {
    const home = await mkdtemp(join(tmpdir(), "nodex-durable-json-"));
    try {
      const directory = join(home, "metadata");
      const file = join(directory, "state.json");
      await writeDurableJson(file, { revision: 1 }, 128);
      await writeDurableJson(file, { revision: 2 }, 128);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ revision: 2 });
      expect(await readdir(directory)).toEqual(["state.json"]);

      await expect(writeDurableJson(file, { value: "x".repeat(128) }, 128)).rejects.toThrow(
        "size limit",
      );
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ revision: 2 });
      expect(await readdir(directory)).toEqual(["state.json"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("persists the latest offer once, in the background, and retries a failed write", async () => {
    const home = await mkdtemp(join(tmpdir(), "nodex-durable-latest-"));
    try {
      const directory = join(home, "metadata");
      const file = join(directory, "state.json");
      // A file where the directory belongs makes every write fail until it is replaced.
      await writeFile(directory, "");
      const errors: unknown[] = [];
      const writer = new LatestDurableTextWriter({
        filePath: file,
        maxBytes: 128,
        delayMs: 60_000,
        onError: (error) => errors.push(error),
      });

      writer.offer("1");
      writer.offer("2");
      await expect(writer.flush()).rejects.toThrow();
      expect(errors).toHaveLength(1);

      await rm(directory);
      await mkdir(directory);
      // The failed payload is kept for the next write.
      await writer.flush();
      expect(await readFile(file, "utf8")).toBe("2");

      writer.offer("3");
      writer.offer("4");
      // An offer returns before anything reaches the disk.
      expect(await readFile(file, "utf8")).toBe("2");
      await writer.flush();
      expect(await readFile(file, "utf8")).toBe("4");
      expect(await readdir(directory)).toEqual(["state.json"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
