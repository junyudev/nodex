import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NEXT_PANEL_PEEK_PX,
  MAX_NEXT_PANEL_PEEK_PX,
  MIN_ENABLED_NEXT_PANEL_PEEK_PX,
  STAGE_RAIL_NEXT_PANEL_PEEK_STORAGE_KEY,
  normalizeNextPanelPeekPx,
  readNextPanelPeekPx,
  writeNextPanelPeekPx,
} from "./stage-rail-peek";

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

describe("stage rail peek settings", () => {
  test("normalizes values and keeps 0 as disabled", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(normalizeNextPanelPeekPx(undefined)).toBe(DEFAULT_NEXT_PANEL_PEEK_PX);
      expect(normalizeNextPanelPeekPx(0)).toBe(0);
      expect(normalizeNextPanelPeekPx(3)).toBe(MIN_ENABLED_NEXT_PANEL_PEEK_PX);
      expect(normalizeNextPanelPeekPx(999)).toBe(MAX_NEXT_PANEL_PEEK_PX);
    });
  });

  test("reads stored values and falls back to default for invalid entries", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(readNextPanelPeekPx()).toBe(DEFAULT_NEXT_PANEL_PEEK_PX);

      mockStorage.setItem(STAGE_RAIL_NEXT_PANEL_PEEK_STORAGE_KEY, "0");
      expect(readNextPanelPeekPx()).toBe(0);

      mockStorage.setItem(STAGE_RAIL_NEXT_PANEL_PEEK_STORAGE_KEY, "not-a-number");
      expect(readNextPanelPeekPx()).toBe(DEFAULT_NEXT_PANEL_PEEK_PX);
    });
  });

  test("writes clamped values to localStorage", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      const low = writeNextPanelPeekPx(1);
      const high = writeNextPanelPeekPx(200);
      const off = writeNextPanelPeekPx(0);

      expect(low).toBe(MIN_ENABLED_NEXT_PANEL_PEEK_PX);
      expect(high).toBe(MAX_NEXT_PANEL_PEEK_PX);
      expect(off).toBe(0);
      expect(mockStorage.getItem(STAGE_RAIL_NEXT_PANEL_PEEK_STORAGE_KEY)).toBe("0");
    });
  });
});
