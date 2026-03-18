import { describe, expect, test } from "bun:test";
import { act } from "@testing-library/react";
import { createElement, useEffect } from "react";
import {
  useWorkbenchState,
  workbenchStorageKeys,
  workbenchTestHelpers,
} from "./use-workbench-state";
import { render, settleAsyncRender } from "../test/dom";

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

if (!(globalThis as { sessionStorage?: unknown }).sessionStorage) {
  (globalThis as { sessionStorage: typeof mockStorage }).sessionStorage = mockStorage;
}

const localStorageRef =
  (globalThis as { localStorage?: typeof mockStorage }).localStorage ?? mockStorage;
const sessionStorageRef =
  (globalThis as { sessionStorage?: typeof mockStorage }).sessionStorage ?? mockStorage;

function resetStorage(): void {
  for (const storage of [localStorageRef, sessionStorageRef]) {
    storage.removeItem("nodex-tabs");
    storage.removeItem(workbenchStorageKeys.workbench);
    storage.removeItem(workbenchStorageKeys.sidebar);
    storage.removeItem(workbenchStorageKeys.dock);
    storage.removeItem(workbenchStorageKeys.recent);
    storage.removeItem(workbenchStorageKeys.dbViewPrefs);
  }
}

describe("use-workbench-state helpers", () => {
  test("reconcileSpaceOrder keeps known order and appends new projects", () => {
    resetStorage();
    const result = workbenchTestHelpers.reconcileSpaceOrder(
      ["b", "a"],
      [
        { id: "a", name: "A", description: "", created: new Date() },
        { id: "b", name: "B", description: "", created: new Date() },
        { id: "c", name: "C", description: "", created: new Date() },
      ],
    );

    expect(JSON.stringify(result)).toBe(JSON.stringify(["b", "a", "c"]));
  });

  test("ensureActiveProject falls back to first project", () => {
    resetStorage();
    const result = workbenchTestHelpers.ensureActiveProject("missing", [
      { id: "first", name: "First", description: "", created: new Date() },
    ]);

    expect(result).toBe("first");
  });

  test("normalizes and validates view map", () => {
    resetStorage();
    const normalized = workbenchTestHelpers.normalizeViewMap({
      one: "kanban",
      two: "invalid",
      three: "calendar",
    });

    expect(JSON.stringify(normalized)).toBe(JSON.stringify({ one: "kanban", three: "calendar" }));
  });

  test("ignores old tabs state and falls back to current defaults", () => {
    resetStorage();
    localStorageRef.setItem(
      "nodex-tabs",
      JSON.stringify({
        tabs: [
          {
            id: "tab-1",
            projectId: "alpha",
            viewMode: "list",
            searchQueries: { alpha: "bug" },
          },
          {
            id: "tab-2",
            projectId: "beta",
            viewMode: "calendar",
            searchQueries: { beta: "today" },
          },
        ],
        activeTabId: "tab-2",
      }),
    );

    const state = workbenchTestHelpers.loadInitialState();

    expect(state.dbProjectId).toBe("default");
    expect(state.threadsProjectId).toBe("default");
    expect(JSON.stringify(state.spaceOrder)).toBe(JSON.stringify([]));
    expect(JSON.stringify(state.viewsByProject)).toBe(JSON.stringify({}));
    expect(JSON.stringify(state.searchByProject)).toBe(JSON.stringify({}));
    expect(state.activeCardsTabId).toBe("");
  });

  test("resume snapshot overrides window session state for restart restore", () => {
    resetStorage();
    sessionStorageRef.setItem(
      workbenchStorageKeys.workbench,
      JSON.stringify({
        dbProjectId: "stale",
        threadsProjectId: "stale",
        viewsByProject: { stale: "kanban" },
        activeCardsTabId: "session:stale",
        activeRecentSessionId: "stale",
        activeThreadsTabId: "thread:stale",
      }),
    );

    const state = workbenchTestHelpers.loadInitialState({
      resumeSnapshot: {
        version: 1,
        dbProjectId: "default",
        threadsProjectId: "ops",
        viewsByProject: { default: "calendar", ops: "list" },
        focusedStage: "threads",
        stageNavDirection: "left",
        activeCardsTabId: "session:recent-1",
        activeRecentSessionId: "recent-1",
        activeThreadsTabId: "thread-1",
        recentCardSessions: [
          {
            id: "recent-1",
            projectId: "default",
            cardId: "card-1",
            titleSnapshot: "Card 1",
            lastOpenedAt: "2026-03-09T00:00:00.000Z",
          },
        ],
        cardStage: {
          open: true,
          projectId: "default",
          cardId: "card-1",
        },
      },
    });

    expect(state.dbProjectId).toBe("default");
    expect(state.threadsProjectId).toBe("ops");
    expect(JSON.stringify(state.viewsByProject)).toBe(JSON.stringify({
      default: "calendar",
      ops: "list",
    }));
    expect(state.focusedStage).toBe("threads");
    expect(state.stageNavDirection).toBe("left");
    expect(state.activeCardsTabId).toBe("session:recent-1");
    expect(state.activeRecentSessionId).toBe("recent-1");
    expect(state.activeThreadsTabId).toBe("thread-1");
    expect(state.recentCardSessions.length).toBe(1);
    expect(state.recentCardSessions[0]?.id).toBe("recent-1");
  });

  test("loads persisted sidebar section collapse and show-more state per project", () => {
    resetStorage();
    sessionStorageRef.setItem(
      workbenchStorageKeys.workbench,
      JSON.stringify({
        sidebarSectionExpandedByProject: {
          default: {
            "cards:status:6-in-progress": true,
          },
        },
        sidebarSectionShowAllByProject: {
          default: {
            "recents:list": true,
          },
        },
      }),
    );

    const state = workbenchTestHelpers.loadInitialState();

    expect(state.sidebarSectionExpandedByProject.default?.["cards:status:6-in-progress"]).toBeTrue();
    expect(state.sidebarSectionShowAllByProject.default?.["recents:list"]).toBeTrue();
  });

  test("loads persisted db-view prefs per project and view", () => {
    resetStorage();
    localStorageRef.setItem(
      workbenchStorageKeys.dbViewPrefs,
      JSON.stringify({
        default: {
          list: {
            summaryExpanded: false,
            rules: {
              filter: {
                any: [
                  {
                    all: [
                      { field: "status", op: "in", values: ["backlog"] },
                    ],
                  },
                ],
              },
              sort: [{ field: "assignee", direction: "asc" }],
            },
          },
        },
      }),
    );

    const state = workbenchTestHelpers.loadInitialState();
    expect(state.dbViewPrefsByProject.default?.list?.summaryExpanded).toBeFalse();
    expect(state.dbViewPrefsByProject.default?.list?.rules.sort[0]?.field).toBe("assignee");
  });

  test("falls back to legacy workbench-session db-view prefs when dedicated storage is empty", () => {
    resetStorage();
    sessionStorageRef.setItem(
      workbenchStorageKeys.workbench,
      JSON.stringify({
        dbViewPrefsByProject: {
          default: {
            kanban: {
              summaryExpanded: false,
              rules: {
                filter: {
                  any: [
                    {
                      all: [
                        { field: "status", op: "in", values: ["done"] },
                      ],
                    },
                  ],
                },
                sort: [{ field: "created", direction: "asc" }],
              },
            },
          },
        },
      }),
    );

    const state = workbenchTestHelpers.loadInitialState();
    expect(state.dbViewPrefsByProject.default?.kanban?.summaryExpanded).toBeFalse();
    expect(state.dbViewPrefsByProject.default?.kanban?.rules.sort[0]?.field).toBe("created");
  });

  test("normalizeRecentSessions caps persisted sessions at ten", () => {
    resetStorage();
    const normalized = workbenchTestHelpers.normalizeRecentSessions(
      Array.from({ length: 12 }, (_, index) => ({
        id: `session-${index + 1}`,
        projectId: "default",
        cardId: `card-${index + 1}`,
        titleSnapshot: `Card ${index + 1}`,
        lastOpenedAt: `2026-03-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      })),
    );

    expect(normalized.length).toBe(10);
    expect(normalized[0]?.id).toBe("session-1");
    expect(normalized[9]?.id).toBe("session-10");
  });

  test("recordRecentCardLeaveInList inserts a newly left card at the front", () => {
    resetStorage();
    const next = workbenchTestHelpers.recordRecentCardLeaveInList(
      [
        {
          id: "session-2",
          projectId: "default",
          cardId: "card-2",
          titleSnapshot: "Card 2",
          lastOpenedAt: "2026-03-02T00:00:00.000Z",
        },
      ],
      "default",
      "card-1",
      "Card 1",
    );

    expect(next.length).toBe(2);
    expect(next[0]?.projectId).toBe("default");
    expect(next[0]?.cardId).toBe("card-1");
    expect(next[0]?.titleSnapshot).toBe("Card 1");
    expect(next[1]?.id).toBe("session-2");
  });

  test("recordRecentCardLeaveInList preserves position for cards already in recents", () => {
    resetStorage();
    const next = workbenchTestHelpers.recordRecentCardLeaveInList(
      [
        {
          id: "session-1",
          projectId: "default",
          cardId: "card-1",
          titleSnapshot: "Card 1",
          lastOpenedAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: "session-2",
          projectId: "default",
          cardId: "card-2",
          titleSnapshot: "Card 2",
          lastOpenedAt: "2026-03-02T00:00:00.000Z",
        },
      ],
      "default",
      "card-2",
      "Card 2 renamed",
    );

    expect(next.length).toBe(2);
    expect(next[0]?.id).toBe("session-1");
    expect(next[1]?.id).toBe("session-2");
    expect(next[1]?.titleSnapshot).toBe("Card 2 renamed");
  });

  test("recordRecentCardLeave updates recents without overwriting the active destination session", async () => {
    resetStorage();

    let latestState: ReturnType<typeof useWorkbenchState> | null = null;
    const projects = [
      { id: "default", name: "Default", description: "", created: new Date("2026-03-01T00:00:00.000Z") },
    ];

    function Harness() {
      const state = useWorkbenchState(
        projects,
        {
          initialResumeSnapshot: {
            version: 1,
            dbProjectId: "default",
            threadsProjectId: "default",
            viewsByProject: { default: "kanban" },
            focusedStage: "cards",
            stageNavDirection: "right",
            activeCardsTabId: "session:session-2",
            activeRecentSessionId: "session-2",
            activeThreadsTabId: "thread:new",
            recentCardSessions: [
              {
                id: "session-2",
                projectId: "default",
                cardId: "card-2",
                titleSnapshot: "Card 2",
                lastOpenedAt: "2026-03-02T00:00:00.000Z",
              },
            ],
            cardStage: {
              open: true,
              projectId: "default",
              cardId: "card-2",
            },
          },
        },
      );

      useEffect(() => {
        latestState = state;
      }, [state]);

      return createElement("div");
    }

    function getLatestState(): ReturnType<typeof useWorkbenchState> {
      if (latestState === null) {
        throw new Error("Expected workbench state to be captured after render.");
      }

      return latestState;
    }

    render(createElement(Harness));
    await settleAsyncRender();

    await act(async () => {
      getLatestState().recordRecentCardLeave("default", "card-1", "Card 1");
    });
    await settleAsyncRender();

    const state = getLatestState();
    expect(state.activeRecentSessionId).toBe("session-2");
    expect(state.activeCardsTabId).toBe("session:session-2");
    expect(state.recentCardSessions.length).toBe(2);
    expect(state.recentCardSessions[0]?.cardId).toBe("card-1");
    expect(state.recentCardSessions[1]?.cardId).toBe("card-2");
  });

  test("findRecentCardSession matches cards by project and card id", () => {
    resetStorage();
    const match = workbenchTestHelpers.findRecentCardSession(
      [
        {
          id: "session-1",
          projectId: "default",
          cardId: "card-1",
          titleSnapshot: "Card 1",
          lastOpenedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      "default",
      "card-1",
    );

    expect(match?.id).toBe("session-1");
  });

  test("resolveCardsStageSelectionForCard keeps card-session and history state separate", () => {
    resetStorage();
    const recentSessions = [
      {
        id: "session-1",
        projectId: "default",
        cardId: "card-1",
        titleSnapshot: "Card 1",
        lastOpenedAt: "2026-03-01T00:00:00.000Z",
      },
    ];

    const existingSelection = workbenchTestHelpers.resolveCardsStageSelectionForCard(
      recentSessions,
      "default",
      "card-1",
    );
    const missingSelection = workbenchTestHelpers.resolveCardsStageSelectionForCard(
      recentSessions,
      "default",
      "card-2",
    );

    expect(existingSelection.activeRecentSessionId).toBe("session-1");
    expect(existingSelection.activeCardsTabId).toBe("session:session-1");
    expect(missingSelection.activeRecentSessionId).toBe(null);
    expect(missingSelection.activeCardsTabId).toBe("");
  });

  test("space refs have stable color and initial", () => {
    resetStorage();
    const one = workbenchTestHelpers.makeSpaceRef("project-a");
    const two = workbenchTestHelpers.makeSpaceRef("project-a");

    expect(one.colorToken).toBe(two.colorToken);
    expect(one.initial).toBe("P");
  });

  test("resolveExpandedStages uses direction for middle stages", () => {
    const right = workbenchTestHelpers.resolveExpandedStages("threads", "right", 2, false);
    const left = workbenchTestHelpers.resolveExpandedStages("threads", "left", 2, false);

    expect(JSON.stringify(right)).toBe(JSON.stringify(["threads", "files"]));
    expect(JSON.stringify(left)).toBe(JSON.stringify(["cards", "threads"]));
  });

  test("resolveExpandedStages collapses to one in narrow mode", () => {
    const result = workbenchTestHelpers.resolveExpandedStages("files", "right", 4, true);
    expect(JSON.stringify(result)).toBe(JSON.stringify(["files"]));
  });

  test("resolveExpandedStages keeps canonical order at edges", () => {
    const right = workbenchTestHelpers.resolveExpandedStages("files", "right", 2, false);
    const left = workbenchTestHelpers.resolveExpandedStages("files", "left", 2, false);

    expect(JSON.stringify(right)).toBe(JSON.stringify(["threads", "files"]));
    expect(JSON.stringify(left)).toBe(JSON.stringify(["threads", "files"]));
  });

  test("resolveExpandedStages supports 3-pane windows", () => {
    const right = workbenchTestHelpers.resolveExpandedStages("cards", "right", 3, false);
    const left = workbenchTestHelpers.resolveExpandedStages("threads", "left", 3, false);

    expect(JSON.stringify(right)).toBe(JSON.stringify(["cards", "threads", "files"]));
    expect(JSON.stringify(left)).toBe(JSON.stringify(["db", "cards", "threads"]));
  });

  test("resolveNearestSlidingWindowDirection keeps visible stage window stable", () => {
    const direction = workbenchTestHelpers.resolveNearestSlidingWindowDirection(
      "cards",
      ["db", "cards"],
      2,
      "right",
    );

    expect(direction).toBe("left");
  });

  test("resolveNearestSlidingWindowDirection picks the nearest window shift", () => {
    const towardsRight = workbenchTestHelpers.resolveNearestSlidingWindowDirection(
      "threads",
      ["db", "cards"],
      2,
      "right",
    );
    const towardsLeft = workbenchTestHelpers.resolveNearestSlidingWindowDirection(
      "cards",
      ["threads", "files"],
      2,
      "left",
    );

    expect(towardsRight).toBe("left");
    expect(towardsLeft).toBe("right");
  });

  test("resolveNearestSlidingWindowDirection falls back when current window is unavailable", () => {
    const direction = workbenchTestHelpers.resolveNearestSlidingWindowDirection(
      "threads",
      ["threads"],
      2,
      "right",
    );

    expect(direction).toBe("right");
  });

  test("resolveSlidingWindowFocusIntent returns nearest direction", () => {
    const files = workbenchTestHelpers.resolveSlidingWindowFocusIntent("files", ["threads", "files"], 2, "left");
    expect(files.direction).toBe("left");
  });

  test("resolveEffectiveSlidingWindowPaneCount caps panes by available width", () => {
    expect(workbenchTestHelpers.resolveEffectiveSlidingWindowPaneCount(4, 1200)).toBe(4);
    expect(workbenchTestHelpers.resolveEffectiveSlidingWindowPaneCount(4, 950)).toBe(3);
    expect(workbenchTestHelpers.resolveEffectiveSlidingWindowPaneCount(4, 540)).toBe(1);
  });

  test("resolveSlidingWindowPaneCountChange grows the window to the right before falling back left", () => {
    const appendRight = workbenchTestHelpers.resolveSlidingWindowPaneCountChange(
      "db",
      "right",
      2,
      "increase",
    );
    const appendLeftFallback = workbenchTestHelpers.resolveSlidingWindowPaneCountChange(
      "threads",
      "right",
      2,
      "increase",
    );

    expect(appendRight.slidingWindowPaneCount).toBe(3);
    expect(appendRight.focusedStage).toBe("db");
    expect(appendRight.stageNavDirection).toBe("right");
    expect(
      JSON.stringify(
        workbenchTestHelpers.resolveExpandedStages(
          appendRight.focusedStage,
          appendRight.stageNavDirection,
          appendRight.slidingWindowPaneCount,
          false,
        ),
      ),
    ).toBe(JSON.stringify(["db", "cards", "threads"]));

    expect(appendLeftFallback.slidingWindowPaneCount).toBe(3);
    expect(
      JSON.stringify(
        workbenchTestHelpers.resolveExpandedStages(
          appendLeftFallback.focusedStage,
          appendLeftFallback.stageNavDirection,
          appendLeftFallback.slidingWindowPaneCount,
          false,
        ),
      ),
    ).toBe(JSON.stringify(["cards", "threads", "files"]));
  });

  test("resolveSlidingWindowPaneCountChange removes the right-most pane", () => {
    const keepFocus = workbenchTestHelpers.resolveSlidingWindowPaneCountChange(
      "cards",
      "right",
      3,
      "decrease",
    );
    const dropFocusedRightEdge = workbenchTestHelpers.resolveSlidingWindowPaneCountChange(
      "threads",
      "left",
      2,
      "decrease",
    );

    expect(keepFocus.slidingWindowPaneCount).toBe(2);
    expect(keepFocus.focusedStage).toBe("cards");
    expect(keepFocus.stageNavDirection).toBe("right");
    expect(
      JSON.stringify(
        workbenchTestHelpers.resolveExpandedStages(
          keepFocus.focusedStage,
          keepFocus.stageNavDirection,
          keepFocus.slidingWindowPaneCount,
          false,
        ),
      ),
    ).toBe(JSON.stringify(["cards", "threads"]));

    expect(dropFocusedRightEdge.slidingWindowPaneCount).toBe(1);
    expect(dropFocusedRightEdge.focusedStage).toBe("cards");
    expect(dropFocusedRightEdge.stageNavDirection).toBe("left");
    expect(
      JSON.stringify(
        workbenchTestHelpers.resolveExpandedStages(
          dropFocusedRightEdge.focusedStage,
          dropFocusedRightEdge.stageNavDirection,
          dropFocusedRightEdge.slidingWindowPaneCount,
          false,
        ),
      ),
    ).toBe(JSON.stringify(["cards"]));
  });

  test("normalizes sliding-window pane count and rejects invalid values", () => {
    expect(workbenchTestHelpers.normalizeSlidingWindowPaneCount(3)).toBe(3);
    expect(workbenchTestHelpers.normalizeSlidingWindowPaneCount(0)).toBe(1);
    expect(workbenchTestHelpers.normalizeSlidingWindowPaneCount(9)).toBe(4);
    expect(workbenchTestHelpers.normalizeSlidingWindowPaneCount(Number.NaN)).toBe(null);
  });

  test("resolves persisted sliding-window pane count from canonical values only", () => {
    const explicit = workbenchTestHelpers.resolvePersistedSlidingWindowPaneCount(3);
    const fallback = workbenchTestHelpers.resolvePersistedSlidingWindowPaneCount(undefined);

    expect(explicit).toBe(3);
    expect(fallback).toBe(2);
  });

  test("ignores legacy workbench-only keys and uses current defaults", () => {
    resetStorage();
    sessionStorageRef.setItem(
      workbenchStorageKeys.workbench,
      JSON.stringify({
        activeProjectId: "beta",
        dualPaneRightFolded: true,
        focusedStageByProject: {
          beta: "threads",
        },
        activeTerminalTabByProject: {
          beta: "project:beta",
        },
      }),
    );

    const state = workbenchTestHelpers.loadInitialState();

    expect(state.dbProjectId).toBe("default");
    expect(state.focusedStage).toBe("db");
    expect(state.slidingWindowPaneCount).toBe(2);
    expect(state.activeTerminalTabId).toBe("project:default");
    resetStorage();
  });

  test("resolveNearestExpandedStage prefers nearby expanded stages", () => {
    const next = workbenchTestHelpers.resolveNearestExpandedStage("threads", {
      threads: true,
      files: true,
    });
    const allCollapsed = workbenchTestHelpers.resolveNearestExpandedStage("db", {
      db: true,
      cards: true,
      threads: true,
      files: true,
    });

    expect(next).toBe("cards");
    expect(allCollapsed).toBe("db");
  });

  test("collapse-disabled policy keeps stage navigation targets accessible", () => {
    const collapsed = workbenchTestHelpers.resolveEffectiveStageCollapsedState(
      { files: true },
      false,
    );
    const next = workbenchTestHelpers.resolveNearestExpandedStage("files", collapsed);

    expect(JSON.stringify(collapsed)).toBe(JSON.stringify({}));
    expect(next).toBe("files");
  });

  test("drops invalid stage ids from persisted stage maps", () => {
    const normalized = workbenchTestHelpers.normalizeStageMap({
      alpha: "terminal",
      beta: "threads",
    });

    expect(JSON.stringify(normalized)).toBe(JSON.stringify({ beta: "threads" }));
  });

  resetStorage();
});
