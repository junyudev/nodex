import { describe, expect, test } from "bun:test";
import {
  DEFAULT_KANBAN_COLUMN_WIDTH,
  getKanbanColumnLayout,
  normalizeKanbanColumnLayoutPrefs,
  readKanbanColumnLayoutPrefs,
  updateKanbanColumnLayoutPrefs,
  writeKanbanColumnLayoutPrefs,
} from "./kanban-column-layout";

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

describe("kanban column layout prefs", () => {
  test("defaults each column to expanded with the standard width", () => {
    expect(JSON.stringify(getKanbanColumnLayout({}, "in_progress"))).toBe(JSON.stringify({
      collapsed: false,
      width: DEFAULT_KANBAN_COLUMN_WIDTH,
    }));
  });

  test("normalizes invalid persisted values and ignores unknown statuses", () => {
    const normalized = normalizeKanbanColumnLayoutPrefs({
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

    expect(JSON.stringify(normalized)).toBe(JSON.stringify({
      backlog: {
        collapsed: true,
        width: 416,
      },
      done: {
        width: 224,
      },
    }));
  });

  test("writes and reads project-scoped layout prefs", () => {
    withMockedLocalStorage(() => {
      const written = writeKanbanColumnLayoutPrefs("alpha", {
        backlog: { collapsed: true, width: 360 },
      });

      expect(JSON.stringify(written)).toBe(JSON.stringify({
        backlog: { collapsed: true, width: 360 },
      }));
      expect(JSON.stringify(readKanbanColumnLayoutPrefs("alpha"))).toBe(JSON.stringify({
        backlog: { collapsed: true, width: 360 },
      }));
      expect(JSON.stringify(readKanbanColumnLayoutPrefs("beta"))).toBe(JSON.stringify({}));
    });
  });

  test("updates a single column while preserving the rest of the layout map", () => {
    const next = updateKanbanColumnLayoutPrefs(
      {
        backlog: { collapsed: true, width: 360 },
        done: { width: 240 },
      },
      "done",
      { collapsed: true, width: 288 },
    );

    expect(JSON.stringify(next)).toBe(JSON.stringify({
      backlog: { collapsed: true, width: 360 },
      done: { collapsed: true, width: 288 },
    }));
  });
});
