import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THREAD_SECTION_SEND_SETTINGS,
  THREAD_SECTION_SEND_SETTINGS_STORAGE_KEY,
  normalizeThreadSectionSendSettings,
  readThreadSectionSendSettings,
  shouldConfirmThreadSectionSend,
  writeThreadSectionConfirmBeforeSend,
  writeThreadSectionSendSettings,
} from "./thread-section-send-settings";

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

describe("thread section send settings", () => {
  test("defaults to confirming and normalizes stored values", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(normalizeThreadSectionSendSettings(undefined).confirmBeforeSend).toBeTrue();
      expect(normalizeThreadSectionSendSettings({ confirmBeforeSend: false }).confirmBeforeSend).toBeFalse();
      expect(normalizeThreadSectionSendSettings({ confirmBeforeSend: "false" }).confirmBeforeSend).toBeFalse();
    });
  });

  test("reads and writes persisted settings", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(readThreadSectionSendSettings().confirmBeforeSend).toBeTrue();

      const disabled = writeThreadSectionSendSettings({ confirmBeforeSend: false });
      expect(disabled.confirmBeforeSend).toBeFalse();
      expect(mockStorage.getItem(THREAD_SECTION_SEND_SETTINGS_STORAGE_KEY)).toBe("{\"confirmBeforeSend\":false}");
      expect(readThreadSectionSendSettings().confirmBeforeSend).toBeFalse();
    });
  });

  test("writes the confirm toggle directly", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      const updated = writeThreadSectionConfirmBeforeSend(false);
      expect(updated.confirmBeforeSend).toBeFalse();
      expect(readThreadSectionSendSettings().confirmBeforeSend).toBeFalse();
    });
  });

  test("resolves the effective confirmation behavior", () => {
    expect(shouldConfirmThreadSectionSend(undefined)).toBeTrue();
    expect(shouldConfirmThreadSectionSend(DEFAULT_THREAD_SECTION_SEND_SETTINGS)).toBeTrue();
    expect(shouldConfirmThreadSectionSend({ confirmBeforeSend: false })).toBeFalse();
  });
});
