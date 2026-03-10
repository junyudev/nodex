import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CARD_STAGE_COLLAPSED_PROPERTIES,
  CARD_STAGE_COLLAPSED_PROPERTIES_STORAGE_KEY,
  formatCardStageCollapsedPropertyCountLabel,
  normalizeCardStageCollapsedProperties,
  readCardStageCollapsedProperties,
  toggleCardStageCollapsedProperty,
  writeCardStageCollapsedProperties,
} from "./card-stage-collapsed-properties";

const storage = new Map<string, string>();
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function withMockedLocalStorage(run: () => void): void {
  storage.clear();

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
  });

  try {
    run();
  } finally {
    storage.clear();

    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
      return;
    }

    // `localStorage` is absent in some test environments.
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

describe("card stage collapsed properties", () => {
  test("defaults to collapsing both optional card-stage properties", () => {
    withMockedLocalStorage(() => {
      expect(stringify(readCardStageCollapsedProperties())).toBe(
        stringify(DEFAULT_CARD_STAGE_COLLAPSED_PROPERTIES),
      );
    });
  });

  test("normalizes persisted values and preserves canonical order", () => {
    expect(
      stringify(
        normalizeCardStageCollapsedProperties(["agentStatus", "tags", "agentBlocked", "invalid", "agentStatus"]),
      ),
    ).toBe(stringify(["tags", "agentBlocked", "agentStatus"]));
  });

  test("writes an empty selection without falling back to defaults", () => {
    withMockedLocalStorage(() => {
      const next = writeCardStageCollapsedProperties([]);

      expect(stringify(next)).toBe(stringify([]));
      expect(storage.get(CARD_STAGE_COLLAPSED_PROPERTIES_STORAGE_KEY)).toBe("");
      expect(stringify(readCardStageCollapsedProperties())).toBe(stringify([]));
    });
  });

  test("toggles individual collapsed properties", () => {
    expect(stringify(toggleCardStageCollapsedProperty(["agentBlocked"], "tags"))).toBe(
      stringify(["tags", "agentBlocked"]),
    );
    expect(stringify(toggleCardStageCollapsedProperty(["agentBlocked", "agentStatus"], "agentBlocked"))).toBe(
      stringify(["agentStatus"]),
    );
  });

  test("formats singular and plural toggle labels", () => {
    expect(formatCardStageCollapsedPropertyCountLabel(1, false)).toBe("1 more property");
    expect(formatCardStageCollapsedPropertyCountLabel(2, true)).toBe("Hide 2 properties");
  });
});
