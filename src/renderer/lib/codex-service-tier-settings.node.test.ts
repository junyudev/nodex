import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY,
  buildCodexServiceTierRequestOverride,
  normalizeCodexServiceTier,
  readCodexServiceTier,
  resolveCodexRequestServiceTier,
  toServiceTierReportingValue,
  writeCodexServiceTier,
} from "./codex-service-tier-settings";

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
};

if (!(globalThis as { localStorage?: unknown }).localStorage) {
  (globalThis as { localStorage: typeof mockStorage }).localStorage = mockStorage;
}

const localStorageRef = (globalThis as { localStorage: typeof mockStorage }).localStorage;

function resetStorage(): void {
  storageMap.clear();
  localStorageRef.removeItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY);
}

describe("codex-service-tier-settings", () => {
  test("preserves service tiers supplied by newer model catalogs", () => {
    resetStorage();
    localStorageRef.setItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY, "flex");

    expect(normalizeCodexServiceTier("fast")).toBe("fast");
    expect(normalizeCodexServiceTier(" flex ")).toBe("flex");
    expect(normalizeCodexServiceTier("default")).toBeNull();
    expect(readCodexServiceTier()).toBe("flex");
  });

  test("writes fast and clears the stored key for standard", () => {
    resetStorage();

    expect(writeCodexServiceTier("fast")).toBe("fast");
    expect(localStorageRef.getItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY)).toBe("fast");
    expect(readCodexServiceTier()).toBe("fast");

    expect(writeCodexServiceTier(null)).toBe(null);
    expect(localStorageRef.getItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY)).toBe(null);
    expect(readCodexServiceTier()).toBe(null);
  });

  test("normalizes reporting and request fallback values", () => {
    resetStorage();

    expect(toServiceTierReportingValue(null)).toBe("standard");
    expect(toServiceTierReportingValue("fast")).toBe("fast");
    expect(JSON.stringify(buildCodexServiceTierRequestOverride(null))).toBe(JSON.stringify({}));
    expect(JSON.stringify(buildCodexServiceTierRequestOverride("fast"))).toBe(
      JSON.stringify({ serviceTier: "fast" }),
    );

    expect(resolveCodexRequestServiceTier(undefined, "fast")).toBe("fast");
    expect(resolveCodexRequestServiceTier({}, "fast")).toBe("fast");
    expect(resolveCodexRequestServiceTier({ serviceTier: null }, "fast")).toBe(null);
    expect(resolveCodexRequestServiceTier({ serviceTier: "fast" }, null)).toBe("fast");
  });
});
