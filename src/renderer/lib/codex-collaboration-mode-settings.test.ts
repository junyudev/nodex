import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CODEX_COLLABORATION_MODE,
  getDraftCollaborationModeStorageKey,
  getThreadCollaborationModeStorageKey,
  migrateDraftCollaborationModeToThread,
  readCollaborationModeForContextKey,
  writeCollaborationModeForContextKey,
} from "./codex-collaboration-mode-settings";

const mockStorage = {
  store: new Map<string, string>(),
  getItem(key: string) {
    return this.store.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    this.store.set(key, value);
  },
  removeItem(key: string) {
    this.store.delete(key);
  },
  clear() {
    this.store.clear();
  },
};

describe("codex collaboration mode settings", () => {
  test("falls back to default mode when storage is missing or invalid", () => {
    const storageGlobal = globalThis as unknown as { localStorage?: typeof mockStorage };
    const previousLocalStorage = storageGlobal.localStorage;
    storageGlobal.localStorage = mockStorage;
    mockStorage.clear();

    try {
      const threadKey = getThreadCollaborationModeStorageKey("thr-1");
      expect(readCollaborationModeForContextKey(threadKey)).toBe(DEFAULT_CODEX_COLLABORATION_MODE);

      mockStorage.setItem("nodex-codex-collaboration-mode-settings-v1", "not-json");
      expect(readCollaborationModeForContextKey(threadKey)).toBe(DEFAULT_CODEX_COLLABORATION_MODE);
    } finally {
      if (previousLocalStorage) {
        storageGlobal.localStorage = previousLocalStorage;
      } else {
        delete storageGlobal.localStorage;
      }
    }
  });

  test("round-trips thread and draft context keys", () => {
    const storageGlobal = globalThis as unknown as { localStorage?: typeof mockStorage };
    const previousLocalStorage = storageGlobal.localStorage;
    storageGlobal.localStorage = mockStorage;
    mockStorage.clear();

    try {
      const threadKey = getThreadCollaborationModeStorageKey("thr-2");
      const draftKey = getDraftCollaborationModeStorageKey("project-1", "card-1");

      writeCollaborationModeForContextKey(threadKey, "plan");
      writeCollaborationModeForContextKey(draftKey, "default");

      expect(readCollaborationModeForContextKey(threadKey)).toBe("plan");
      expect(readCollaborationModeForContextKey(draftKey)).toBe("default");
    } finally {
      if (previousLocalStorage) {
        storageGlobal.localStorage = previousLocalStorage;
      } else {
        delete storageGlobal.localStorage;
      }
    }
  });

  test("migrates draft mode to thread mode and removes draft key", () => {
    const storageGlobal = globalThis as unknown as { localStorage?: typeof mockStorage };
    const previousLocalStorage = storageGlobal.localStorage;
    storageGlobal.localStorage = mockStorage;
    mockStorage.clear();

    try {
      const projectId = "project-2";
      const cardId = "card-2";
      const threadId = "thr-3";
      const draftKey = getDraftCollaborationModeStorageKey(projectId, cardId);
      const threadKey = getThreadCollaborationModeStorageKey(threadId);

      writeCollaborationModeForContextKey(draftKey, "plan");
      const migrated = migrateDraftCollaborationModeToThread({ projectId, cardId, threadId });

      expect(migrated).toBe("plan");
      expect(readCollaborationModeForContextKey(threadKey)).toBe("plan");
      expect(readCollaborationModeForContextKey(draftKey)).toBe(DEFAULT_CODEX_COLLABORATION_MODE);
    } finally {
      if (previousLocalStorage) {
        storageGlobal.localStorage = previousLocalStorage;
      } else {
        delete storageGlobal.localStorage;
      }
    }
  });
});
