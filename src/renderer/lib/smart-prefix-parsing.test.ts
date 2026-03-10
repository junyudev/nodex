import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SMART_PREFIX_PARSING_ENABLED,
  DEFAULT_STRIP_SMART_PREFIX_FROM_TITLE_ENABLED,
  SMART_PREFIX_PARSING_ENABLED_STORAGE_KEY,
  STRIP_SMART_PREFIX_FROM_TITLE_STORAGE_KEY,
  normalizeSmartPrefixParsingEnabled,
  normalizeStripSmartPrefixFromTitleEnabled,
  readSmartPrefixParsingEnabled,
  readStripSmartPrefixFromTitleEnabled,
  writeSmartPrefixParsingEnabled,
  writeStripSmartPrefixFromTitleEnabled,
} from "./smart-prefix-parsing";

const storageMap = new Map<string, string>();

const mockStorage = {
  getItem(key: string): string | null {
    return storageMap.has(key) ? storageMap.get(key) ?? null : null;
  },
  setItem(key: string, value: string): void {
    storageMap.set(key, value);
  },
  clear(): void {
    storageMap.clear();
  },
};

function withMockLocalStorage(run: () => void): void {
  const storageGlobal = globalThis as { localStorage?: typeof mockStorage };
  const previousLocalStorage = storageGlobal.localStorage;
  storageGlobal.localStorage = mockStorage;
  try {
    run();
  } finally {
    if (previousLocalStorage) {
      storageGlobal.localStorage = previousLocalStorage;
      return;
    }
    delete storageGlobal.localStorage;
  }
}

describe("smart prefix parsing settings", () => {
  test("normalizes parsing toggle values", () => {
    expect(normalizeSmartPrefixParsingEnabled(undefined)).toBe(
      DEFAULT_SMART_PREFIX_PARSING_ENABLED,
    );
    expect(normalizeSmartPrefixParsingEnabled("true")).toBeTrue();
    expect(normalizeSmartPrefixParsingEnabled("false")).toBeFalse();
    expect(normalizeSmartPrefixParsingEnabled("unexpected")).toBe(
      DEFAULT_SMART_PREFIX_PARSING_ENABLED,
    );
  });

  test("normalizes strip-title toggle values", () => {
    expect(normalizeStripSmartPrefixFromTitleEnabled(undefined)).toBe(
      DEFAULT_STRIP_SMART_PREFIX_FROM_TITLE_ENABLED,
    );
    expect(normalizeStripSmartPrefixFromTitleEnabled("true")).toBeTrue();
    expect(normalizeStripSmartPrefixFromTitleEnabled("false")).toBeFalse();
    expect(normalizeStripSmartPrefixFromTitleEnabled("unexpected")).toBe(
      DEFAULT_STRIP_SMART_PREFIX_FROM_TITLE_ENABLED,
    );
  });

  test("reads persisted parsing values from localStorage", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(readSmartPrefixParsingEnabled()).toBe(
        DEFAULT_SMART_PREFIX_PARSING_ENABLED,
      );

      mockStorage.setItem(SMART_PREFIX_PARSING_ENABLED_STORAGE_KEY, "false");
      expect(readSmartPrefixParsingEnabled()).toBeFalse();
    });
  });

  test("reads persisted strip-title values from localStorage", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(readStripSmartPrefixFromTitleEnabled()).toBe(
        DEFAULT_STRIP_SMART_PREFIX_FROM_TITLE_ENABLED,
      );

      mockStorage.setItem(STRIP_SMART_PREFIX_FROM_TITLE_STORAGE_KEY, "false");
      expect(readStripSmartPrefixFromTitleEnabled()).toBeFalse();
    });
  });

  test("writes normalized toggle values to localStorage", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();

      const parsingEnabled = writeSmartPrefixParsingEnabled(true);
      expect(parsingEnabled).toBeTrue();
      expect(mockStorage.getItem(SMART_PREFIX_PARSING_ENABLED_STORAGE_KEY)).toBe("true");

      const stripEnabled = writeStripSmartPrefixFromTitleEnabled(false);
      expect(stripEnabled).toBeFalse();
      expect(mockStorage.getItem(STRIP_SMART_PREFIX_FROM_TITLE_STORAGE_KEY)).toBe("false");
    });
  });
});
