import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STAGE_RAIL_LAYOUT_MODE,
  STAGE_RAIL_LAYOUT_MODE_STORAGE_KEY,
  normalizeStageRailLayoutMode,
  readStageRailLayoutMode,
  writeStageRailLayoutMode,
} from "./stage-rail-layout-mode";

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

if (!(globalThis as { localStorage?: unknown }).localStorage) {
  (globalThis as { localStorage: typeof mockStorage }).localStorage = mockStorage;
}

describe("stage-rail-layout-mode", () => {
  test("normalizes invalid values to sliding-window", () => {
    expect(normalizeStageRailLayoutMode("unknown")).toBe(DEFAULT_STAGE_RAIL_LAYOUT_MODE);
    expect(normalizeStageRailLayoutMode(123)).toBe(DEFAULT_STAGE_RAIL_LAYOUT_MODE);
    expect(normalizeStageRailLayoutMode(null)).toBe(DEFAULT_STAGE_RAIL_LAYOUT_MODE);
  });

  test("resets unknown persisted values to sliding-window", () => {
    expect(normalizeStageRailLayoutMode("dual-pane")).toBe("sliding-window");
  });

  test("reads and writes layout mode from localStorage", () => {
    mockStorage.removeItem(STAGE_RAIL_LAYOUT_MODE_STORAGE_KEY);
    expect(readStageRailLayoutMode()).toBe("sliding-window");

    const written = writeStageRailLayoutMode("full-rail");
    expect(written).toBe("full-rail");
    expect(readStageRailLayoutMode()).toBe("full-rail");
  });
});
