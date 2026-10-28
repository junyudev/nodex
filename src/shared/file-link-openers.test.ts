import { describe, expect, test } from "vite-plus/test";
import {
  buildFileUrl,
  DEFAULT_FILE_LINK_OPENER_ID,
  formatFileLinkLocation,
  getFileManagerRevealLabel,
  getFileManagerName,
  normalizeFileLinkOpenerId,
  parseLocalFileLinkHref,
} from "./file-link-openers";

const EXAMPLE_PARSER_PATH = "/workspace/nodex/src/renderer/lib/nfm/parser.ts";
const EXAMPLE_MAIN_PATH = "/workspace/nodex/src/main/index.ts";

describe("file link openers", () => {
  test.each([
    ["darwin", "Finder"],
    ["MacIntel", "Finder"],
    ["win32", "File Explorer"],
    ["Win32", "File Explorer"],
    ["linux", "File Manager"],
    ["", "File Manager"],
  ])("names the native file manager for %s", (platform, expected) => {
    expect(getFileManagerName(platform)).toBe(expected);
  });
  test.each([
    ["darwin", "Reveal in Finder"],
    ["MacIntel", "Reveal in Finder"],
    ["win32", "Open in Explorer"],
    ["Win32", "Open in Explorer"],
    ["linux", "Open in File Manager"],
  ])("names the native file-manager action for %s", (platform, expected) => {
    expect(getFileManagerRevealLabel(platform)).toBe(expected);
  });
  test("parses absolute file paths and line fragments", () => {
    expect(JSON.stringify(parseLocalFileLinkHref(`${EXAMPLE_PARSER_PATH}#L71`))).toBe(
      JSON.stringify({
        path: EXAMPLE_PARSER_PATH,
        line: 71,
      }),
    );
  });

  test("parses file URLs with line and column fragments", () => {
    expect(JSON.stringify(parseLocalFileLinkHref(`file://${EXAMPLE_MAIN_PATH}#L55C3`))).toBe(
      JSON.stringify({
        path: EXAMPLE_MAIN_PATH,
        line: 55,
        column: 3,
      }),
    );
  });

  test("parses ranged line and column fragments", () => {
    expect(parseLocalFileLinkHref(`${EXAMPLE_PARSER_PATH}#L71C3-L76C8`)).toEqual({
      path: EXAMPLE_PARSER_PATH,
      line: 71,
      column: 3,
      endLine: 76,
      endColumn: 8,
    });
  });

  test("ignores non-file links", () => {
    expect(parseLocalFileLinkHref("https://example.com")).toBe(null);
    expect(parseLocalFileLinkHref("parser.ts")).toBe(null);
  });

  test("normalizes stored opener IDs", () => {
    expect(normalizeFileLinkOpenerId("CURSOR")).toBe("cursor");
    expect(normalizeFileLinkOpenerId("finder")).toBe("fileManager");
    expect(normalizeFileLinkOpenerId("android-studio")).toBe("androidStudio");
    expect(normalizeFileLinkOpenerId("unexpected")).toBe(DEFAULT_FILE_LINK_OPENER_ID);
  });

  test("formats file targets for editor commands and fallback URLs", () => {
    const target = {
      path: EXAMPLE_PARSER_PATH,
      line: 71,
      column: 4,
    };

    expect(formatFileLinkLocation(target)).toBe(`${EXAMPLE_PARSER_PATH}:71:4`);
    expect(buildFileUrl(target)).toBe(`file://${EXAMPLE_PARSER_PATH}#L71C4`);
  });
});
