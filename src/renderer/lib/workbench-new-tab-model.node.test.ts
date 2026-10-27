import { describe, expect, test } from "vite-plus/test";
import type {
  WorkbenchObservedTab,
  WorkbenchRendererObservation,
} from "../../shared/nodex-app-tools/workbench";
import {
  formatNewTabRecentTime,
  planNewTabReplacement,
  resolveNewTabToolLayout,
} from "./workbench-new-tab-model";
import { getPanelNewTabAction, type PanelNewTabActionKind } from "./workbench-panel-actions";

const actions = (...kinds: PanelNewTabActionKind[]) => kinds.map(getPanelNewTabAction);
const kinds = (list: readonly { readonly kind: string }[]) => list.map((action) => action.kind);
const withShortcut = (action: { readonly shortcut?: string }) => action.shortcut !== undefined;

describe("New tab tool layout", () => {
  test("shows every Session tool in four rows, shortcut tools first and project content last", () => {
    const layout = resolveNewTabToolLayout(
      actions(
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
      { hasChat: false, hasShortcut: withShortcut },
    );

    expect(kinds(layout.tiles)).toEqual([
      "review",
      "terminal",
      "files",
      "side_chat",
      "new_page",
      "db_view",
      "page_stage",
      "canvas_stage",
    ]);
    expect(layout.moreTools).toEqual([]);
    expect(layout.projectContent).toEqual([]);
  });

  test("fills every slot when nothing overflows", () => {
    const layout = resolveNewTabToolLayout(actions("review", "side_chat", "browser", "terminal"), {
      hasChat: false,
      hasShortcut: withShortcut,
    });

    expect(kinds(layout.tiles)).toEqual(["review", "side_chat", "terminal"]);
    expect(layout.moreTools).toEqual([]);
    expect(layout.projectContent).toEqual([]);
  });

  test("counts Chat as a tile and moves the overflow behind More tools by section", () => {
    const layout = resolveNewTabToolLayout(
      actions(
        "review",
        "terminal",
        "files",
        "side_chat",
        "new_page",
        "db_view",
        "page_stage",
        "canvas_stage",
      ),
      { hasChat: true, hasShortcut: withShortcut },
    );

    expect(kinds(layout.tiles)).toEqual([
      "review",
      "terminal",
      "files",
      "side_chat",
      "new_page",
      "db_view",
    ]);
    expect(layout.moreTools).toEqual([]);
    expect(kinds(layout.projectContent)).toEqual(["page_stage", "canvas_stage"]);
  });

  test("sorts by the effective shortcut, including custom bindings", () => {
    const layout = resolveNewTabToolLayout(actions("terminal", "new_page", "files"), {
      hasChat: false,
      hasShortcut: (action) => action.kind === "new_page",
    });

    expect(kinds(layout.tiles)).toEqual(["new_page", "terminal", "files"]);
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
