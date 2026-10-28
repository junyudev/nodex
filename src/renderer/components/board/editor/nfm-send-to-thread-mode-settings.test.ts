import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_NFM_SEND_TO_THREAD_MODE,
  NFM_SEND_TO_THREAD_MODE_STORAGE_KEY,
  normalizeNfmSendToThreadMode,
  readNfmSendToThreadMode,
  writeNfmSendToThreadMode,
} from "./nfm-send-to-thread-mode-settings";

const storageMap = new Map<string, string>();

const mockStorage = {
  getItem(key: string): string | null {
    return storageMap.has(key) ? (storageMap.get(key) ?? null) : null;
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

const throwingStorage = {
  getItem(): string | null {
    throw new Error("storage unavailable");
  },
  setItem(): void {
    throw new Error("storage unavailable");
  },
  removeItem(): void {},
  clear(): void {},
};

function withMockLocalStorage(storage: typeof mockStorage, run: () => void): void {
  const storageGlobal = globalThis as { localStorage?: typeof mockStorage };
  const previousLocalStorage = storageGlobal.localStorage;
  storageGlobal.localStorage = storage;
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

describe("markdown send-to-thread mode settings", () => {
  test("normalizes mode values", () => {
    expect(normalizeNfmSendToThreadMode("send")).toBe("send");
    expect(normalizeNfmSendToThreadMode("wrap-toggle")).toBe("wrap-toggle");
    expect(normalizeNfmSendToThreadMode("other")).toBe(DEFAULT_NFM_SEND_TO_THREAD_MODE);
    expect(normalizeNfmSendToThreadMode(null)).toBe(DEFAULT_NFM_SEND_TO_THREAD_MODE);
  });

  test("reads and writes both persisted modes", () => {
    withMockLocalStorage(mockStorage, () => {
      mockStorage.clear();
      expect(readNfmSendToThreadMode()).toBe("send");

      const wrapped = writeNfmSendToThreadMode("wrap-toggle");
      expect(wrapped).toBe("wrap-toggle");
      expect(mockStorage.getItem(NFM_SEND_TO_THREAD_MODE_STORAGE_KEY)).toBe("wrap-toggle");
      expect(readNfmSendToThreadMode()).toBe("wrap-toggle");

      const send = writeNfmSendToThreadMode("send");
      expect(send).toBe("send");
      expect(mockStorage.getItem(NFM_SEND_TO_THREAD_MODE_STORAGE_KEY)).toBe("send");
      expect(readNfmSendToThreadMode()).toBe("send");
    });
  });

  test("falls back for invalid stored values", () => {
    withMockLocalStorage(mockStorage, () => {
      mockStorage.clear();
      mockStorage.setItem(NFM_SEND_TO_THREAD_MODE_STORAGE_KEY, "not-real");
      expect(readNfmSendToThreadMode()).toBe("send");
      expect(writeNfmSendToThreadMode("not-real")).toBe("send");
      expect(mockStorage.getItem(NFM_SEND_TO_THREAD_MODE_STORAGE_KEY)).toBe("send");
    });
  });

  test("falls back when localStorage throws", () => {
    withMockLocalStorage(throwingStorage, () => {
      expect(readNfmSendToThreadMode()).toBe("send");
      expect(writeNfmSendToThreadMode("wrap-toggle")).toBe("wrap-toggle");
    });
  });
});
