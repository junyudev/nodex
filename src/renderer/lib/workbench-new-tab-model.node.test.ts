import { describe, expect, test } from "vite-plus/test";
import type {
  WorkbenchObservedTab,
  WorkbenchRendererObservation,
} from "../../shared/nodex-app-tools/workbench";
import {
  formatNewTabRecentTime,
  NEW_TAB_RECENT_MAX_ROWS,
  planNewTabReplacement,
  resolveNewTabRecentsHeight,
  reorderNewTabShortcuts,
  resolveNewTabShortcutLayout,
  toggleNewTabShortcutPin,
  type NewTabShortcutPreference,
} from "./workbench-new-tab-model";
import { getPanelNewTabAction, type PanelNewTabActionKind } from "./workbench-panel-actions";

const actions = (...kinds: PanelNewTabActionKind[]) => kinds.map(getPanelNewTabAction);
const kinds = (list: readonly { readonly kind: string }[]) => list.map((action) => action.kind);

describe("New tab shortcut layout", () => {
  test.each([
    {
      scene: "a chat Scene",
      available: actions(
        "review",
        "terminal",
        "browser",
        "files",
        "side_chat",
        "new_page",
        "db_view",
        "page_stage",
        "canvas_stage",
      ),
      tools: [
        "new_page",
        "side_chat",
        "terminal",
        "files",
        "review",
        "page_stage",
        "db_view",
        "canvas_stage",
      ],
      pinned: ["new_page", "side_chat", "terminal", "files"],
    },
    {
      scene: "a Project Scene",
      available: actions(
        "files",
        "browser",
        "db_view",
        "new_page",
        "canvas_stage",
        "terminal",
        "page_stage",
      ),
      tools: ["new_page", "terminal", "files", "page_stage", "db_view", "canvas_stage"],
      pinned: ["new_page", "terminal", "files", "page_stage"],
    },
    {
      scene: "the bottom panel",
      available: actions("terminal", "files", "side_chat", "browser"),
      tools: ["side_chat", "terminal", "files"],
      pinned: ["side_chat", "terminal", "files"],
    },
  ])("ranks and pins default tools in $scene", ({ available, tools, pinned }) => {
    const layout = resolveNewTabShortcutLayout(available, null);

    expect(kinds(layout.tools)).toEqual(tools);
    expect(kinds(layout.pinned)).toEqual(pinned);
  });

  test("uses the first action when multiple actions offer the same tool", () => {
    const files = getPanelNewTabAction("files");
    const duplicate = { ...files, label: "Duplicate" };

    const layout = resolveNewTabShortcutLayout([files, duplicate], null);

    expect(layout.tools).toHaveLength(1);
    expect(layout.tools[0]).toBe(files);
  });

  test("applies the saved order and appends new tools in default rank", () => {
    const layout = resolveNewTabShortcutLayout(
      actions("files", "new_page", "db_view", "terminal"),
      {
        order: ["db_view", "side_chat", "files", "db_view"],
        pinned: ["terminal", "side_chat", "db_view"],
      },
    );

    expect(kinds(layout.tools)).toEqual(["db_view", "files", "new_page", "terminal"]);
    expect(kinds(layout.pinned)).toEqual(["db_view", "terminal"]);
  });

  test("shows no pinned tools when the person unpins them all", () => {
    const layout = resolveNewTabShortcutLayout(actions("files", "terminal"), {
      order: ["files", "terminal"],
      pinned: [],
    });

    expect(kinds(layout.tools)).toEqual(["files", "terminal"]);
    expect(layout.pinned).toEqual([]);
  });
});

describe("New tab shortcut edits", () => {
  test("toggling from the default keeps the four default pins and adds the chosen tool", () => {
    const available = actions("files", "review", "terminal", "new_page", "side_chat", "db_view");
    const layout = resolveNewTabShortcutLayout(available, null);
    const next = toggleNewTabShortcutPin(layout, null, "review");

    expect(next.order).toEqual(["new_page", "side_chat", "terminal", "files", "review", "db_view"]);
    expect(new Set(next.pinned)).toEqual(
      new Set(["new_page", "side_chat", "terminal", "files", "review"]),
    );

    const withAnotherTool = resolveNewTabShortcutLayout(
      [...available, getPanelNewTabAction("page_stage")],
      next,
    );
    expect(kinds(withAnotherTool.tools)).toEqual([...next.order, "page_stage"]);
    expect(kinds(withAnotherTool.pinned)).toEqual([
      "new_page",
      "side_chat",
      "terminal",
      "files",
      "review",
    ]);
  });

  test("pinning and unpinning leave the menu order and hidden pins in place", () => {
    const available = actions("terminal", "db_view", "files");
    const saved: NewTabShortcutPreference = {
      order: ["db_view", "side_chat", "files"],
      pinned: ["files", "side_chat"],
    };
    const layout = resolveNewTabShortcutLayout(available, saved);

    const pinned = toggleNewTabShortcutPin(layout, saved, "db_view");
    const afterPin = resolveNewTabShortcutLayout(available, pinned);
    expect(kinds(afterPin.tools)).toEqual(kinds(layout.tools));
    expect(kinds(afterPin.pinned)).toEqual(["db_view", "files"]);

    const unpinned = toggleNewTabShortcutPin(afterPin, pinned, "files");
    const afterUnpin = resolveNewTabShortcutLayout(available, unpinned);
    expect(kinds(afterUnpin.tools)).toEqual(kinds(layout.tools));
    expect(kinds(afterUnpin.pinned)).toEqual(["db_view"]);
    expect(unpinned.order).toEqual(["db_view", "side_chat", "files", "terminal"]);
    expect(new Set(unpinned.pinned)).toEqual(new Set(["db_view", "side_chat"]));
  });

  test("reordering puts pinned tools in their new positions and keeps the same pins", () => {
    const available = actions("files", "new_page", "terminal", "review", "side_chat");
    const layout = resolveNewTabShortcutLayout(available, null);
    const next = reorderNewTabShortcuts(layout, null, [
      "review",
      "files",
      "new_page",
      "side_chat",
      "terminal",
    ]);

    const reordered = resolveNewTabShortcutLayout(available, next);
    expect(kinds(reordered.tools)).toEqual([
      "review",
      "files",
      "new_page",
      "side_chat",
      "terminal",
    ]);
    expect(kinds(reordered.pinned)).toEqual(["files", "new_page", "side_chat", "terminal"]);
  });

  test("reordering fills only visible slots and appends skipped tools in current order", () => {
    const available = actions("files", "terminal", "page_stage", "db_view");
    const saved: NewTabShortcutPreference = {
      order: ["files", "side_chat", "terminal", "review", "review", "page_stage"],
      pinned: ["review", "review", "side_chat", "files", "new_page"],
    };
    const layout = resolveNewTabShortcutLayout(available, saved);
    const next = reorderNewTabShortcuts(layout, saved, ["db_view", "side_chat", "db_view"]);

    expect(next.order).toEqual([
      "db_view",
      "side_chat",
      "files",
      "review",
      "terminal",
      "page_stage",
    ]);
    expect(next.pinned).toHaveLength(4);
    expect(new Set(next.pinned)).toEqual(new Set(["side_chat", "review", "files", "new_page"]));

    const restored = resolveNewTabShortcutLayout(
      [...available, ...actions("side_chat", "review", "new_page")],
      next,
    );
    expect(kinds(restored.pinned)).toEqual(["side_chat", "files", "review", "new_page"]);
  });
});

function tab(tabId: string, groupId: string, overrides: Partial<WorkbenchObservedTab> = {}) {
  return {
    tabId,
    panelId: "right",
    groupId,
    protected: false,
    persisted: true,
    preview: false,
    selected: false,
    visible: false,
    surface: null,
    ...overrides,
  } as WorkbenchObservedTab;
}

function observe(
  groups: readonly {
    readonly groupId: string;
    readonly tabIds: readonly string[];
    readonly selectedTabId: string | null;
  }[],
  tabs: readonly WorkbenchObservedTab[] = groups.flatMap((group) =>
    group.tabIds.map((tabId) => tab(tabId, group.groupId)),
  ),
  activeGroupId: string = groups[0]?.groupId ?? "",
): WorkbenchRendererObservation {
  return {
    groups: groups.map((group) => ({
      panelId: "right" as const,
      focused: false,
      visible: true,
      ...group,
      tabIds: [...group.tabIds],
    })),
    panels: [
      { panelId: "right", collapsed: false, activeGroupId, maximizedGroupId: null, size: {} },
    ],
    tabs,
  } as unknown as WorkbenchRendererObservation;
}

describe("New tab replacement", () => {
  test("moves a tab opened at the end of the group into the New tab's place", () => {
    const plan = planNewTabReplacement({
      newTabId: "new",
      before: observe([{ groupId: "g", tabIds: ["a", "new", "b"], selectedTabId: "new" }]),
      after: observe([{ groupId: "g", tabIds: ["a", "new", "b", "page"], selectedTabId: "page" }]),
    });

    expect(plan).toEqual({
      kind: "replace",
      groupId: "g",
      reorderedTabIds: ["a", "page", "new", "b"],
    });
  });

  test("closes without reordering when the opened tab already sits before the New tab", () => {
    const plan = planNewTabReplacement({
      newTabId: "new",
      before: observe([{ groupId: "g", tabIds: ["a", "new"], selectedTabId: "new" }]),
      after: observe([{ groupId: "g", tabIds: ["a", "page", "new"], selectedTabId: "page" }]),
    });

    expect(plan).toEqual({ kind: "replace", groupId: "g", reorderedTabIds: null });
  });

  test("retires the New tab when an already-open tab in its group is selected", () => {
    const plan = planNewTabReplacement({
      newTabId: "new",
      before: observe([{ groupId: "g", tabIds: ["review", "new"], selectedTabId: "new" }]),
      after: observe([{ groupId: "g", tabIds: ["review", "new"], selectedTabId: "review" }]),
    });

    expect(plan).toEqual({ kind: "replace", groupId: "g", reorderedTabIds: null });
  });

  test("retires the New tab when its result is revealed in another group", () => {
    const plan = planNewTabReplacement({
      newTabId: "new",
      before: observe([
        { groupId: "g", tabIds: ["new"], selectedTabId: "new" },
        { groupId: "h", tabIds: ["files", "review"], selectedTabId: "files" },
      ]),
      after: observe([
        { groupId: "g", tabIds: ["new"], selectedTabId: "new" },
        { groupId: "h", tabIds: ["files", "review"], selectedTabId: "review" },
      ]),
    });

    expect(plan).toEqual({ kind: "replace", groupId: "g", reorderedTabIds: null });
  });

  test("retires the New tab when an already-selected tab in another group is revealed", () => {
    const groups = [
      { groupId: "g", tabIds: ["new"], selectedTabId: "new" },
      { groupId: "h", tabIds: ["review"], selectedTabId: "review" },
    ];
    const plan = planNewTabReplacement({
      newTabId: "new",
      before: observe(groups, undefined, "g"),
      after: observe(groups, undefined, "h"),
    });

    expect(plan).toEqual({ kind: "replace", groupId: "g", reorderedTabIds: null });
  });

  test("moves a renderer-local Side chat into the New tab's place", () => {
    const plan = planNewTabReplacement({
      newTabId: "new",
      before: observe([{ groupId: "g", tabIds: ["files", "new", "web"], selectedTabId: "new" }]),
      after: observe(
        [{ groupId: "g", tabIds: ["files", "new", "web", "side"], selectedTabId: "side" }],
        [
          tab("files", "g"),
          tab("new", "g"),
          tab("web", "g"),
          tab("side", "g", {
            persisted: false,
            auxiliary: { kind: "side_chat", title: "Side chat" },
          } as Partial<WorkbenchObservedTab>),
        ],
      ),
    });

    expect(plan).toEqual({
      kind: "replace",
      groupId: "g",
      reorderedTabIds: ["files", "side", "new", "web"],
    });
  });

  test("keeps the New tab when nothing else became visible", () => {
    const before = observe([{ groupId: "g", tabIds: ["new"], selectedTabId: "new" }]);

    expect(planNewTabReplacement({ newTabId: "new", before, after: before })).toEqual({
      kind: "keep",
    });
  });

  test("does not reorder a preview it cannot move", () => {
    const plan = planNewTabReplacement({
      newTabId: "new",
      before: observe([{ groupId: "g", tabIds: ["new", "a"], selectedTabId: "new" }]),
      after: observe(
        [{ groupId: "g", tabIds: ["new", "a", "preview"], selectedTabId: "preview" }],
        [tab("new", "g"), tab("a", "g"), tab("preview", "g", { persisted: false, preview: true })],
      ),
    });

    expect(plan).toEqual({ kind: "replace", groupId: "g", reorderedTabIds: null });
  });
});

describe("New tab recent times", () => {
  const now = new Date(2026, 9, 27, 18, 0);

  test("shows a time for today", () => {
    expect(formatNewTabRecentTime(new Date(2026, 9, 27, 9, 5), now, "en-US")).toBe("9:05 AM");
  });

  test("shows a date for earlier days and adds the year only across years", () => {
    expect(formatNewTabRecentTime(new Date(2026, 9, 25, 9, 5), now, "en-US")).toBe("Oct 25");
    expect(formatNewTabRecentTime(new Date(2025, 11, 31, 9, 5), now, "en-US")).toBe("Dec 31, 2025");
  });
});

describe("New tab recents height", () => {
  test.each([
    // Room for four rows and the half-row peek shows four and a half.
    { available: 4.5 * 57, rows: 4.5 },
    // A peek that does not fully fit costs the last whole row.
    { available: 4.4 * 57, rows: 3.5 },
    // Short tabs keep two rows to scroll through.
    { available: 40, rows: 2.5 },
    // Tall tabs stop at the cap; the list scrolls past it.
    { available: 2000, rows: NEW_TAB_RECENT_MAX_ROWS },
  ])("fits $rows rows into $available px", ({ available, rows }) => {
    expect(resolveNewTabRecentsHeight(available, 57)).toBe(rows * 57);
  });

  test("measures nothing before rows have a height", () => {
    expect(resolveNewTabRecentsHeight(400, 0)).toBe(0);
  });
});
