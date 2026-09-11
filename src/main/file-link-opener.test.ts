import { mkdtemp, mkdir, writeFile, symlink, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vite-plus/test";
import path from "node:path";
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

const parserPath = path.join(process.cwd(), "src/renderer/lib/nfm/parser.ts");
const parserDirectory = path.dirname(parserPath);
const vscodeIconPath = path.join(process.cwd(), "src/renderer/assets/open-file-targets/vscode.png");

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
      `txmt://open/?url=${encodeURIComponent(`file://${parserPath}`)}&line=71&column=1`,
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
