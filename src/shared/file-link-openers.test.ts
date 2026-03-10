import { describe, expect, test } from "bun:test";
import {
  buildFileUrl,
  DEFAULT_FILE_LINK_OPENER_ID,
  formatFileLinkLocation,
  normalizeFileLinkOpenerId,
  parseLocalFileLinkHref,
} from "./file-link-openers";

const EXAMPLE_PARSER_PATH = "/workspace/nodex/src/renderer/lib/nfm/parser.ts";
const EXAMPLE_MAIN_PATH = "/workspace/nodex/src/main/index.ts";

describe("file link openers", () => {
  test("parses absolute file paths and line fragments", () => {
    expect(JSON.stringify(
      parseLocalFileLinkHref(`${EXAMPLE_PARSER_PATH}#L71`),
    )).toBe(JSON.stringify({
      path: EXAMPLE_PARSER_PATH,
      line: 71,
    }));
  });

  test("parses file URLs with line and column fragments", () => {
    expect(JSON.stringify(
      parseLocalFileLinkHref(`file://${EXAMPLE_MAIN_PATH}#L55C3`),
    )).toBe(JSON.stringify({
      path: EXAMPLE_MAIN_PATH,
      line: 55,
      column: 3,
    }));
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

    expect(formatFileLinkLocation(target)).toBe(
      `${EXAMPLE_PARSER_PATH}:71:4`,
    );
    expect(buildFileUrl(target)).toBe(
      `file://${EXAMPLE_PARSER_PATH}#L71C4`,
    );
  });
});
