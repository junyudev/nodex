import { describe, expect, test } from "bun:test";
import {
  FILE_LINK_OPENER_STORAGE_KEY,
  readFileLinkOpener,
  writeFileLinkOpener,
} from "./file-link-opener-settings";

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

describe("file link opener settings", () => {
  test("defaults to VS Code when nothing is stored", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(readFileLinkOpener()).toBe("vscode");
    });
  });

  test("persists and normalizes stored opener values", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();

      expect(writeFileLinkOpener("cursor")).toBe("cursor");
      expect(mockStorage.getItem(FILE_LINK_OPENER_STORAGE_KEY)).toBe("cursor");
      expect(readFileLinkOpener()).toBe("cursor");

      mockStorage.setItem(FILE_LINK_OPENER_STORAGE_KEY, "not-real");
      expect(readFileLinkOpener()).toBe("vscode");
    });
  });
});
