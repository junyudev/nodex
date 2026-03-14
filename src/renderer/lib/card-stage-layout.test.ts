import { describe, expect, test } from "bun:test";
import {
  readCardStageContentWidthPreference,
  readCardStageShowRawContentPreference,
  writeCardStageContentWidthPreference,
  writeCardStageShowRawContentPreference,
} from "./card-stage-layout";

describe("card-stage layout", () => {
  function withMockLocalStorage(run: () => void): void {
    const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map<string, string>();
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
      if (originalLocalStorageDescriptor) {
        Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
        return;
      }

      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }

  test("defaults to limiting the main content width", () => {
    withMockLocalStorage(() => {
      expect(readCardStageContentWidthPreference()).toBeTrue();
    });
  });

  test("persists the width preference", () => {
    withMockLocalStorage(() => {
      writeCardStageContentWidthPreference(false);

      expect(readCardStageContentWidthPreference()).toBeFalse();
    });
  });

  test("defaults to hiding raw content mode", () => {
    withMockLocalStorage(() => {
      expect(readCardStageShowRawContentPreference()).toBeFalse();
    });
  });

  test("persists the raw content preference without clobbering width", () => {
    withMockLocalStorage(() => {
      writeCardStageContentWidthPreference(false);
      writeCardStageShowRawContentPreference(true);

      expect(readCardStageContentWidthPreference()).toBeFalse();
      expect(readCardStageShowRawContentPreference()).toBeTrue();
    });
  });
});
