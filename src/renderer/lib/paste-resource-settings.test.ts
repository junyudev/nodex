import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PASTE_RESOURCE_SETTINGS,
  PASTE_RESOURCE_SETTINGS_STORAGE_KEY,
  normalizePasteResourceSettings,
  readPasteResourceSettings,
  writePasteResourceSettings,
} from "./paste-resource-settings";

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

describe("paste resource settings", () => {
  test("defaults to the shipped thresholds", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      const settings = readPasteResourceSettings();
      expect(settings.textPromptCharThreshold).toBe(
        DEFAULT_PASTE_RESOURCE_SETTINGS.textPromptCharThreshold,
      );
      expect(settings.descriptionSoftLimit).toBe(
        DEFAULT_PASTE_RESOURCE_SETTINGS.descriptionSoftLimit,
      );
    });
  });

  test("persists normalized thresholds", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();

      const written = writePasteResourceSettings({
        textPromptCharThreshold: "120000",
        descriptionSoftLimit: "800000",
      });

      expect(written.textPromptCharThreshold).toBe(120000);
      expect(written.descriptionSoftLimit).toBe(800000);
      expect(mockStorage.getItem(PASTE_RESOURCE_SETTINGS_STORAGE_KEY)).not.toBeNull();

      const normalized = normalizePasteResourceSettings({
        textPromptCharThreshold: "not-a-number",
        descriptionSoftLimit: 5,
      });

      expect(normalized.textPromptCharThreshold).toBe(
        DEFAULT_PASTE_RESOURCE_SETTINGS.textPromptCharThreshold,
      );
      expect(normalized.descriptionSoftLimit).toBe(10000);
    });
  });
});
