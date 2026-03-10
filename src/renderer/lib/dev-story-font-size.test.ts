import { describe, expect, test } from "bun:test";
import {
  DEV_STORY_CODE_FONT_SIZE_STORAGE_KEY,
  DEV_STORY_SANS_FONT_SIZE_STORAGE_KEY,
  getDevStoryFontSizeCssVariables,
  readDevStoryCodeFontSize,
  readDevStorySansFontSize,
  writeDevStoryCodeFontSize,
  writeDevStorySansFontSize,
} from "./dev-story-font-size";

const storageMap = new Map<string, string>();

const mockStorage = {
  getItem(key: string): string | null {
    return storageMap.has(key) ? storageMap.get(key) ?? null : null;
  },
  setItem(key: string, value: string): void {
    storageMap.set(key, value);
  },
  removeItem(key: string): void {
    storageMap.delete(key);
  },
};

if (!(globalThis as { localStorage?: unknown }).localStorage) {
  (globalThis as { localStorage: typeof mockStorage }).localStorage = mockStorage;
}

describe("dev-story-font-size", () => {
  test("reads and writes separate sans and code font sizes", () => {
    mockStorage.removeItem(DEV_STORY_SANS_FONT_SIZE_STORAGE_KEY);
    mockStorage.removeItem(DEV_STORY_CODE_FONT_SIZE_STORAGE_KEY);

    expect(readDevStorySansFontSize()).toBe(15);
    expect(readDevStoryCodeFontSize()).toBe(14);

    expect(writeDevStorySansFontSize(15)).toBe(15);
    expect(writeDevStoryCodeFontSize(16)).toBe(16);
    expect(readDevStorySansFontSize()).toBe(15);
    expect(readDevStoryCodeFontSize()).toBe(16);
  });

  test("builds scoped css variables for dev story surfaces", () => {
    const variables = getDevStoryFontSizeCssVariables({
      sansFontSize: 16,
      codeFontSize: 14,
    });

    expect(variables["--sans-font-size"]).toBe("16px");
    expect(variables["--text-base"]).toBe("16px");
    expect(variables["--vscode-editor-font-size"]).toBe("14px");
  });
});
