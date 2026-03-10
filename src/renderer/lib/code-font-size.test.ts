import { describe, expect, test } from "bun:test";
import {
  CODE_FONT_SIZE_STORAGE_KEY,
  DEFAULT_CODE_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  applyCodeFontSizeRootVariable,
  normalizeCodeFontSize,
  readCodeFontSize,
  writeCodeFontSize,
} from "./code-font-size";

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

describe("code-font-size", () => {
  test("normalizes invalid values to the default", () => {
    expect(normalizeCodeFontSize(null)).toBe(DEFAULT_CODE_FONT_SIZE);
    expect(normalizeCodeFontSize("")).toBe(DEFAULT_CODE_FONT_SIZE);
    expect(normalizeCodeFontSize("abc")).toBe(DEFAULT_CODE_FONT_SIZE);
  });

  test("clamps values to the supported range", () => {
    expect(normalizeCodeFontSize(MIN_CODE_FONT_SIZE - 5)).toBe(MIN_CODE_FONT_SIZE);
    expect(normalizeCodeFontSize(MAX_CODE_FONT_SIZE + 5)).toBe(MAX_CODE_FONT_SIZE);
  });

  test("reads and writes persisted values", () => {
    mockStorage.removeItem(CODE_FONT_SIZE_STORAGE_KEY);
    expect(readCodeFontSize()).toBe(DEFAULT_CODE_FONT_SIZE);

    const written = writeCodeFontSize(14);
    expect(written).toBe(14);
    expect(readCodeFontSize()).toBe(14);
  });

  test("writes --vscode-editor-font-size to the root style", () => {
    const written = new Map<string, string>();
    const root = {
      style: {
        setProperty(name: string, value: string) {
          written.set(name, value);
        },
      },
    } as unknown as Pick<HTMLElement, "style">;

    const applied = applyCodeFontSizeRootVariable(root, 15);
    expect(applied).toBe(15);
    expect(written.get("--vscode-editor-font-size")).toBe("15px");
  });
});
