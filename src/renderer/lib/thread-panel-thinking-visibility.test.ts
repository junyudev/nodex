import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THREAD_PANEL_HIDE_THINKING_WHEN_DONE,
  THREAD_PANEL_HIDE_THINKING_WHEN_DONE_STORAGE_KEY,
  normalizeThreadPanelHideThinkingWhenDone,
  readThreadPanelHideThinkingWhenDone,
  writeThreadPanelHideThinkingWhenDone,
} from "./thread-panel-thinking-visibility";

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

describe("thread panel thinking visibility", () => {
  test("defaults to hide thinking when done and normalizes known values", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(normalizeThreadPanelHideThinkingWhenDone(undefined)).toBe(
        DEFAULT_THREAD_PANEL_HIDE_THINKING_WHEN_DONE,
      );
      expect(normalizeThreadPanelHideThinkingWhenDone("true")).toBeTrue();
      expect(normalizeThreadPanelHideThinkingWhenDone("false")).toBeFalse();
      expect(normalizeThreadPanelHideThinkingWhenDone("unexpected")).toBe(
        DEFAULT_THREAD_PANEL_HIDE_THINKING_WHEN_DONE,
      );
    });
  });

  test("reads persisted values from localStorage", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(readThreadPanelHideThinkingWhenDone()).toBe(DEFAULT_THREAD_PANEL_HIDE_THINKING_WHEN_DONE);

      mockStorage.setItem(THREAD_PANEL_HIDE_THINKING_WHEN_DONE_STORAGE_KEY, "false");
      expect(readThreadPanelHideThinkingWhenDone()).toBeFalse();
    });
  });

  test("writes normalized values to localStorage", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();

      const hideWhenDone = writeThreadPanelHideThinkingWhenDone(true);
      expect(hideWhenDone).toBeTrue();
      expect(mockStorage.getItem(THREAD_PANEL_HIDE_THINKING_WHEN_DONE_STORAGE_KEY)).toBe("true");

      const showWhenDone = writeThreadPanelHideThinkingWhenDone(false);
      expect(showWhenDone).toBeFalse();
      expect(mockStorage.getItem(THREAD_PANEL_HIDE_THINKING_WHEN_DONE_STORAGE_KEY)).toBe("false");
    });
  });
});
