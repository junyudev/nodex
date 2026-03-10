import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THREAD_PROMPT_SUBMIT_SHORTCUT,
  THREAD_PROMPT_SUBMIT_SHORTCUT_STORAGE_KEY,
  normalizeThreadPromptSubmitShortcut,
  readThreadPromptSubmitShortcut,
  shouldSubmitThreadPromptFromKeyDown,
  writeThreadPromptSubmitShortcut,
} from "./thread-panel-prompt-submit-shortcut";

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

describe("thread panel prompt submit shortcut", () => {
  test("defaults to enter and normalizes known values", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(normalizeThreadPromptSubmitShortcut(undefined)).toBe(
        DEFAULT_THREAD_PROMPT_SUBMIT_SHORTCUT,
      );
      expect(normalizeThreadPromptSubmitShortcut("enter")).toBe("enter");
      expect(normalizeThreadPromptSubmitShortcut("mod-enter")).toBe("mod-enter");
      expect(normalizeThreadPromptSubmitShortcut("cmd+enter")).toBe("mod-enter");
      expect(normalizeThreadPromptSubmitShortcut("unexpected")).toBe(
        DEFAULT_THREAD_PROMPT_SUBMIT_SHORTCUT,
      );
    });
  });

  test("reads and writes persisted values", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(readThreadPromptSubmitShortcut()).toBe(
        DEFAULT_THREAD_PROMPT_SUBMIT_SHORTCUT,
      );

      const modShortcut = writeThreadPromptSubmitShortcut("mod-enter");
      expect(modShortcut).toBe("mod-enter");
      expect(
        mockStorage.getItem(THREAD_PROMPT_SUBMIT_SHORTCUT_STORAGE_KEY),
      ).toBe("mod-enter");
      expect(readThreadPromptSubmitShortcut()).toBe("mod-enter");
    });
  });

  test("submits on plain enter in enter mode", () => {
    expect(
      shouldSubmitThreadPromptFromKeyDown({
        shortcut: "enter",
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBeTrue();
    expect(
      shouldSubmitThreadPromptFromKeyDown({
        shortcut: "enter",
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBeFalse();
    expect(
      shouldSubmitThreadPromptFromKeyDown({
        shortcut: "enter",
        key: "Enter",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
      }),
    ).toBeFalse();
  });

  test("submits on cmd/ctrl+enter in modifier mode", () => {
    expect(
      shouldSubmitThreadPromptFromKeyDown({
        shortcut: "mod-enter",
        key: "Enter",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
      }),
    ).toBeTrue();
    expect(
      shouldSubmitThreadPromptFromKeyDown({
        shortcut: "mod-enter",
        key: "Enter",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBeTrue();
    expect(
      shouldSubmitThreadPromptFromKeyDown({
        shortcut: "mod-enter",
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBeFalse();
  });

  test("never submits while composing", () => {
    expect(
      shouldSubmitThreadPromptFromKeyDown({
        shortcut: "enter",
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        isComposing: true,
      }),
    ).toBeFalse();
  });
});
