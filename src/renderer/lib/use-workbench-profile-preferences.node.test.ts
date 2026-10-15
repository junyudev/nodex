import { describe, expect, test } from "vite-plus/test";
import {
  legacyWorkbenchProfilePreferencesStorageKey,
  loadWorkbenchProfilePreferencesFromStorage,
  normalizeLegacyWorkbenchProfilePreferences,
  normalizeWorkbenchProfilePreferences,
  recordRecentPageLeaveInPreferences,
  workbenchProfilePreferencesStorageKey,
} from "./use-workbench-profile-preferences";

describe("Workbench profile preferences", () => {
  test("uses the default sidebar width only when storage has no valid explicit width", () => {
    expect(normalizeWorkbenchProfilePreferences(undefined).sidebar.width).toBe(288);
    expect(normalizeWorkbenchProfilePreferences({ sidebar: {} }).sidebar.width).toBe(288);
    expect(
      normalizeWorkbenchProfilePreferences({ sidebar: { width: Number.NaN } }).sidebar.width,
    ).toBe(288);
    expect(normalizeWorkbenchProfilePreferences({ sidebar: { width: 300 } }).sidebar.width).toBe(
      300,
    );
    expect(
      normalizeLegacyWorkbenchProfilePreferences({ sidebar: { width: 300 } }).sidebar.width,
    ).toBe(300);
  });

  test("fresh and malformed profile storage use the same default sidebar width", () => {
    const storage = (raw: string | null) => ({
      getItem: () => raw,
      setItem: () => {},
      removeItem: () => {},
    });
    expect(loadWorkbenchProfilePreferencesFromStorage(storage(null)).sidebar.width).toBe(288);
    expect(loadWorkbenchProfilePreferencesFromStorage(storage("malformed")).sidebar.width).toBe(
      288,
    );
  });

  test("normalizes persisted preferences at the storage boundary", () => {
    const preferences = normalizeWorkbenchProfilePreferences({
      viewsByProject: {
        "project-a": "calendar",
        "project-b": "unsupported",
      },
      sidebar: {
        collapsed: true,
        width: 9_000,
        collapsibleSections: {
          pinned: true,
          chats: true,
        },
      },
      recentPageSessions: [
        {
          id: "recent-a",
          projectId: "project-a",
          pageId: "page-a",
          titleSnapshot: "Page A",
          lastOpenedAt: "2026-07-28T00:00:00.000Z",
        },
        { id: "invalid" },
      ],
      databaseViewTabs: {
        displayModeByDatabaseId: {
          "database-a": "icon_only",
          "database-b": "unsupported",
        },
        ruleBarOpenByViewId: {
          "view-a": true,
          "view-b": false,
          "view-invalid": "yes",
        },
      },
    });

    expect(preferences).not.toHaveProperty("viewsByProject");
    expect(preferences.sidebar).toEqual({
      collapsed: true,
      width: 520,
      collapsibleSections: {
        pinned: true,
        pages: false,
        projects: false,
        chats: true,
      },
    });
    expect(preferences.recentPageSessions).toHaveLength(1);
    expect(preferences.databaseViewTabs.displayModeByDatabaseId).toEqual({
      "database-a": "icon_only",
    });
    expect(preferences.databaseViewTabs.ruleBarOpenByViewId).toEqual({
      "view-a": true,
      "view-b": false,
    });
  });

  test("drops retired Database presentation preferences", () => {
    const preferences = normalizeLegacyWorkbenchProfilePreferences({
      dbViewPrefsByProject: {
        "project-a": {
          list: {
            rules: {
              filter: {
                any: [
                  {
                    all: [
                      {
                        field: "priority",
                        op: "in",
                        values: ["p4-later", "p3-low"],
                        includeEmpty: false,
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    });

    expect(preferences).not.toHaveProperty("dbViewPrefsByProject");
  });

  test("retains v1 profile preferences when the v2 write fails", () => {
    const values = new Map<string, string>([
      [
        legacyWorkbenchProfilePreferencesStorageKey,
        JSON.stringify({
          dbViewPrefsByProject: {
            "project-a": {
              list: {
                rules: {
                  filter: {
                    any: [
                      {
                        all: [
                          {
                            field: "priority",
                            op: "in",
                            values: ["p4-later"],
                            includeEmpty: false,
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
      ],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === workbenchProfilePreferencesStorageKey) {
          throw new Error("storage full");
        }
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };

    const loaded = loadWorkbenchProfilePreferencesFromStorage(storage);

    expect(loaded).not.toHaveProperty("dbViewPrefsByProject");
    expect(values.has(workbenchProfilePreferencesStorageKey)).toBe(false);
    expect(values.has(legacyWorkbenchProfilePreferencesStorageKey)).toBe(true);
  });

  test("preserves recent Page identity while refreshing its snapshot", () => {
    const recent = recordRecentPageLeaveInPreferences(
      [
        {
          id: "stable-session",
          projectId: "project-a",
          pageId: "page-a",
          titleSnapshot: "Old title",
          lastOpenedAt: "2026-07-27T00:00:00.000Z",
        },
      ],
      {
        id: "unused-new-id",
        projectId: "project-a",
        pageId: "page-a",
        titleSnapshot: "New title",
        lastOpenedAt: "2026-07-28T00:00:00.000Z",
      },
    );

    expect(recent).toEqual([
      {
        id: "stable-session",
        projectId: "project-a",
        pageId: "page-a",
        titleSnapshot: "New title",
        lastOpenedAt: "2026-07-28T00:00:00.000Z",
      },
    ]);
  });

  test("keeps the recent Page list bounded", () => {
    const existing = Array.from({ length: 10 }, (_, index) => ({
      id: `recent-${index}`,
      projectId: "project-a",
      pageId: `page-${index}`,
      titleSnapshot: `Page ${index}`,
      lastOpenedAt: "2026-07-27T00:00:00.000Z",
    }));

    const recent = recordRecentPageLeaveInPreferences(existing, {
      id: "new-recent",
      projectId: "project-b",
      pageId: "new-page",
      titleSnapshot: "New Page",
      lastOpenedAt: "2026-07-28T00:00:00.000Z",
    });

    expect(recent).toHaveLength(10);
    expect(recent[0]?.id).toBe("new-recent");
    expect(recent.some((session) => session.id === "recent-9")).toBe(false);
  });
});
