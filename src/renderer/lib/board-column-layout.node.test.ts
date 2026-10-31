import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_BOARD_COLUMN_WIDTH,
  getBoardColumnLayout,
  normalizeBoardColumnLayoutPrefs,
  readBoardColumnLayoutPrefs,
  updateBoardColumnLayoutPrefs,
  writeBoardColumnLayoutPrefs,
} from "./board-column-layout";

const storage = new Map<string, string>();
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

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

    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

describe("board column layout prefs", () => {
  test("defaults each column to expanded with the standard width", () => {
    expect(JSON.stringify(getBoardColumnLayout({}, "doing"))).toBe(
      JSON.stringify({
        collapsed: false,
        width: DEFAULT_BOARD_COLUMN_WIDTH,
      }),
    );
  });

  test("normalizes invalid persisted values and ignores unknown statuses", () => {
    const normalized = normalizeBoardColumnLayoutPrefs({
      backlog: {
        collapsed: true,
        width: 999,
      },
      done: {
        width: 120,
      },
      archive: {
        collapsed: true,
      },
    });

    expect(JSON.stringify(normalized)).toBe(
      JSON.stringify({
        plan: {
          collapsed: true,
          width: 416,
        },
        done: {
          width: 224,
        },
      }),
    );
  });

  test("prefers a canonical column key over its legacy alias", () => {
    expect(
      normalizeBoardColumnLayoutPrefs({
        backlog: { collapsed: true, width: 320 },
        plan: { collapsed: false, width: 360 },
      }),
    ).toEqual({
      plan: { collapsed: false, width: 360 },
    });
  });

  test("writes and reads project-scoped layout prefs", () => {
    withMockedLocalStorage(() => {
      const written = writeBoardColumnLayoutPrefs("alpha", {
        plan: { collapsed: true, width: 360 },
      });

      expect(JSON.stringify(written)).toBe(
        JSON.stringify({
          plan: { collapsed: true, width: 360 },
        }),
      );
      expect(JSON.stringify(readBoardColumnLayoutPrefs("alpha"))).toBe(
        JSON.stringify({
          plan: { collapsed: true, width: 360 },
        }),
      );
      expect(JSON.stringify(readBoardColumnLayoutPrefs("beta"))).toBe(JSON.stringify({}));
    });
  });

  test("updates a single column while preserving the rest of the layout map", () => {
    const next = updateBoardColumnLayoutPrefs(
      {
        plan: { collapsed: true, width: 360 },
        done: { width: 240 },
      },
      "done",
      { collapsed: true, width: 288 },
    );

    expect(JSON.stringify(next)).toBe(
      JSON.stringify({
        plan: { collapsed: true, width: 360 },
        done: { collapsed: true, width: 288 },
      }),
    );
  });
});
