import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX,
  normalizeWorktreeAutoBranchPrefix,
  readWorktreeAutoBranchPrefix,
  WORKTREE_AUTO_BRANCH_PREFIX_STORAGE_KEY,
  writeWorktreeAutoBranchPrefix,
} from "./worktree-branch-prefix";

const storageMap = new Map<string, string>();

const mockStorage = {
  getItem(key: string): string | null {
    return storageMap.has(key) ? storageMap.get(key) ?? null : null;
  },
  setItem(key: string, value: string): void {
    storageMap.set(key, value);
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

describe("worktree auto-branch prefix setting", () => {
  test("normalizes known values and falls back to default", () => {
    expect(normalizeWorktreeAutoBranchPrefix(undefined)).toBe(
      DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX,
    );
    expect(normalizeWorktreeAutoBranchPrefix("NODEX")).toBe("nodex/");
    expect(normalizeWorktreeAutoBranchPrefix(" feature/team ")).toBe("feature/team/");
    expect(normalizeWorktreeAutoBranchPrefix("feature // API v2")).toBe("feature/api-v2/");
    expect(normalizeWorktreeAutoBranchPrefix("///")).toBe(
      DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX,
    );
  });

  test("reads and writes persisted prefix values", () => {
    withMockLocalStorage(() => {
      mockStorage.clear();
      expect(readWorktreeAutoBranchPrefix()).toBe(
        DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX,
      );

      const next = writeWorktreeAutoBranchPrefix("team");
      expect(next).toBe("team/");
      expect(mockStorage.getItem(WORKTREE_AUTO_BRANCH_PREFIX_STORAGE_KEY)).toBe(
        "team/",
      );
      expect(readWorktreeAutoBranchPrefix()).toBe("team/");
    });
  });
});
