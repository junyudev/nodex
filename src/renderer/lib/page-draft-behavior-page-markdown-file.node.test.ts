import { describe, expect, test, afterEach, beforeAll, beforeEach, it } from "vite-plus/test";
import {
  encodeUtf8Base64,
  pageMarkdownFileContents,
  pageMarkdownFileName,
} from "./page-markdown-file";
import {
  LEGACY_SMART_PREFIX_PARSING_STORAGE_KEY,
  LEGACY_STRIP_SMART_PREFIX_STORAGE_KEY,
  TASK_SHORTHAND_PAGE_PROMOTION_STORAGE_KEY,
  readTaskShorthandPagePromotionEnabled,
  writeTaskShorthandPagePromotionEnabled,
} from "./page-promotion-preference";

describe("page Markdown file", () => {
  test("names the file after the title, safe for the file system", () => {
    expect(pageMarkdownFileName("Release plan")).toBe("Release plan.md");
    expect(pageMarkdownFileName("  Q3: plan / review?  ")).toBe("Q3_ plan _ review_.md");
    expect(pageMarkdownFileName("   ")).toBe("Untitled.md");
    expect(pageMarkdownFileName("line\nbreak")).toBe("line break.md");
  });

  test("leads with the title as the one top-level heading", () => {
    expect(pageMarkdownFileContents("Release plan", "## Goal\n\nShip it.\n\n")).toBe(
      "# Release plan\n\n## Goal\n\nShip it.\n",
    );
    expect(pageMarkdownFileContents("", "")).toBe("# Untitled\n");
  });

  test("encodes Unicode text as UTF-8", () => {
    expect(encodeUtf8Base64("é ✓")).toBe(Buffer.from("é ✓", "utf8").toString("base64"));
  });
});

describe("task shorthand Page promotion preference", () => {
  beforeAll(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("defaults new Profiles to disabled", () => {
    expect(readTaskShorthandPagePromotionEnabled()).toBe(false);
    expect(localStorage.getItem(TASK_SHORTHAND_PAGE_PROMOTION_STORAGE_KEY)).toBe("false");
  });

  it.each([
    ["true", "true", true],
    ["true", null, true],
    [null, "true", true],
    ["false", "true", false],
    ["true", "false", false],
    ["false", "false", false],
  ])("migrates legacy parse=%s strip=%s to %s", (parse, strip, expected) => {
    if (parse) localStorage.setItem(LEGACY_SMART_PREFIX_PARSING_STORAGE_KEY, parse);
    if (strip) localStorage.setItem(LEGACY_STRIP_SMART_PREFIX_STORAGE_KEY, strip);
    expect(readTaskShorthandPagePromotionEnabled()).toBe(expected);
    expect(localStorage.getItem(TASK_SHORTHAND_PAGE_PROMOTION_STORAGE_KEY)).toBe(String(expected));
    expect(localStorage.getItem(LEGACY_SMART_PREFIX_PARSING_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_STRIP_SMART_PREFIX_STORAGE_KEY)).toBeNull();
  });

  it("persists one coherent mode", () => {
    expect(writeTaskShorthandPagePromotionEnabled(false)).toBe(false);
    expect(readTaskShorthandPagePromotionEnabled()).toBe(false);
  });
});
