import { describe, expect, test } from "bun:test";
import {
  areNavigationSnapshotsEqual,
  navigateBackInHistory,
  navigateForwardInHistory,
  navigationHistoryStorageKey,
  navigationHistoryTestHelpers,
  readNavigationHistoryState,
  recordNavigationTransition,
  writeNavigationHistoryState,
  type NavigationSnapshot,
} from "./workbench-navigation-history";

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
};

if (!(globalThis as { sessionStorage?: unknown }).sessionStorage) {
  (globalThis as { sessionStorage: typeof mockStorage }).sessionStorage = mockStorage;
}

function resetStorage(): void {
  ((globalThis as { sessionStorage?: typeof mockStorage }).sessionStorage ?? mockStorage).removeItem(navigationHistoryStorageKey);
}

function makeSnapshot(overrides: Partial<NavigationSnapshot> = {}): NavigationSnapshot {
  return {
    dbProjectId: overrides.dbProjectId ?? "default",
    activeView: overrides.activeView ?? "kanban",
    focusedStage: overrides.focusedStage ?? "db",
    stageNavDirection: overrides.stageNavDirection ?? "right",
    cardStage: overrides.cardStage ?? {
      open: false,
      projectId: "",
      cardId: null,
    },
    activeCardsTabId: overrides.activeCardsTabId ?? "",
    activeRecentSessionId: overrides.activeRecentSessionId ?? null,
    threadsProjectId: overrides.threadsProjectId ?? "default",
    activeThreadsTabId: overrides.activeThreadsTabId ?? "thread:new",
    activeFilesTabId: overrides.activeFilesTabId ?? "diff",
  };
}

describe("workbench navigation history", () => {
  test("records only material transitions", () => {
    resetStorage();
    const current = makeSnapshot();
    const history = recordNavigationTransition(
      { backStack: [], forwardStack: [] },
      current,
      makeSnapshot(),
    );

    expect(history.backStack.length).toBe(0);
    expect(history.forwardStack.length).toBe(0);
  });

  test("dedupes repeated snapshots at the top of the back stack", () => {
    resetStorage();
    const first = makeSnapshot();
    const second = makeSnapshot({ focusedStage: "cards" });
    const initial = recordNavigationTransition({ backStack: [], forwardStack: [] }, first, second);
    const next = recordNavigationTransition(initial, second, makeSnapshot({ focusedStage: "threads" }));

    expect(next.backStack.length).toBe(2);
    expect(areNavigationSnapshotsEqual(next.backStack[0] as NavigationSnapshot, first)).toBeTrue();
    expect(areNavigationSnapshotsEqual(next.backStack[1] as NavigationSnapshot, second)).toBeTrue();
  });

  test("clears the forward stack on fresh navigation", () => {
    resetStorage();
    const first = makeSnapshot();
    const second = makeSnapshot({ focusedStage: "cards" });
    const third = makeSnapshot({ focusedStage: "threads" });
    const backState = navigateBackInHistory(
      recordNavigationTransition(
        recordNavigationTransition({ backStack: [], forwardStack: [] }, first, second),
        second,
        third,
      ),
      third,
    ).historyState;

    const next = recordNavigationTransition(backState, second, makeSnapshot({ focusedStage: "files" }));

    expect(next.forwardStack.length).toBe(0);
  });

  test("restores the prior snapshot when navigating back and forward", () => {
    resetStorage();
    const first = makeSnapshot();
    const second = makeSnapshot({ focusedStage: "cards", activeCardsTabId: "session:s-1" });
    const third = makeSnapshot({ focusedStage: "threads", activeThreadsTabId: "thr-1" });
    const history = recordNavigationTransition(
      recordNavigationTransition({ backStack: [], forwardStack: [] }, first, second),
      second,
      third,
    );

    const backResult = navigateBackInHistory(history, third);
    expect(backResult.snapshot?.focusedStage).toBe("cards");
    expect(backResult.historyState.forwardStack.length).toBe(1);
    expect(backResult.historyState.forwardStack[0]?.focusedStage).toBe("threads");

    const forwardResult = navigateForwardInHistory(backResult.historyState, second);
    expect(forwardResult.snapshot?.focusedStage).toBe("threads");
    expect(forwardResult.historyState.backStack.length).toBe(2);
  });

  test("persists history in session storage", () => {
    resetStorage();
    const state = writeNavigationHistoryState({
      backStack: [makeSnapshot({ focusedStage: "cards" })],
      forwardStack: [makeSnapshot({ focusedStage: "threads" })],
    });

    const restored = readNavigationHistoryState();

    expect(JSON.stringify(restored)).toBe(JSON.stringify(state));
  });

  test("normalizes invalid persisted history entries", () => {
    resetStorage();
    ((globalThis as { sessionStorage?: typeof mockStorage }).sessionStorage ?? mockStorage).setItem(
      navigationHistoryStorageKey,
      JSON.stringify({
        backStack: [{ focusedStage: "invalid" }, makeSnapshot({ focusedStage: "cards" })],
        forwardStack: ["bad-entry"],
      }),
    );

    const restored = readNavigationHistoryState();

    expect(restored.backStack.length).toBe(1);
    expect(restored.backStack[0]?.focusedStage).toBe("cards");
    expect(restored.forwardStack.length).toBe(0);
  });

  test("caps normalized stacks at the max history size", () => {
    resetStorage();
    const maxEntries = navigationHistoryTestHelpers.MAX_HISTORY_ENTRIES;
    const restored = navigationHistoryTestHelpers.normalizeNavigationHistoryState({
      backStack: Array.from({ length: maxEntries + 5 }, (_, index) =>
        makeSnapshot({ activeCardsTabId: `session:${index}` })),
      forwardStack: [],
    });

    expect(restored.backStack.length).toBe(maxEntries);
  });
});
