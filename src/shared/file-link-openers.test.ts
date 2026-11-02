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

const EXAMPLE_PARSER_PATH = "/workspace/nodex/src/renderer/lib/markdown/parser.ts";
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

  test.each([
    ["file://server/share/doc.md", "//server/share/doc.md"],
    ["file://server/share/my%20doc.md", "//server/share/my doc.md"],
  ])("preserves the network host in %s", (href, path) => {
    expect(parseLocalFileLinkHref(`${href}#L55C3-L57C8`)).toEqual({
      path,
      line: 55,
      column: 3,
      endLine: 57,
      endColumn: 8,
    });
  });

  test.each([
    ["file:///workspace/my%20doc.md", "/workspace/my doc.md"],
    ["file://localhost/workspace/my%20doc.md", "/workspace/my doc.md"],
    ["file://LOCALHOST/workspace/my%20doc.md", "/workspace/my doc.md"],
    ["file:///C:/workspace/my%20doc.md", "C:/workspace/my doc.md"],
    ["file://localhost/C:/workspace/my%20doc.md", "C:/workspace/my doc.md"],
  ])("keeps %s local", (href, path) => {
    expect(parseLocalFileLinkHref(href)).toEqual({ path });
  });

  test("rejects a network file URL with invalid path encoding", () => {
    expect(parseLocalFileLinkHref("file://server/share/%ZZ.md")).toBeNull();
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

test.each(["C:\\workspace\\我的 #1%.ts", "\\\\server\\share\\我的 #1%.ts"])(
  "round-trips native Windows file URLs and line fragments: %s",
  (path) => {
    expect(parseLocalFileLinkHref(buildFileUrl({ path, line: 7, column: 3 }))).toEqual({
      path: path.replaceAll("\\", "/"),
      line: 7,
      column: 3,
    });
  },
);

test("preserves literal POSIX filename characters in a file URL", () => {
  const path = String.raw`/workspace/notes\#?.md`;
  expect(parseLocalFileLinkHref(buildFileUrl({ path, line: 7 }))).toEqual({ path, line: 7 });
});
