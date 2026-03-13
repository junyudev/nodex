import { describe, expect, mock, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarDays, SquareKanban, Table2 } from "lucide-react";

mock.module("@/lib/utils", () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" "),
}));

type DbViewToolbarItem = {
  id: string;
  label: string;
  icon?: typeof SquareKanban;
  active?: boolean;
  onSelect: () => void;
};

const ITEMS: DbViewToolbarItem[] = [
  {
    id: "kanban",
    label: "Board",
    icon: SquareKanban,
    active: true,
    onSelect: () => undefined,
  },
  {
    id: "list",
    label: "Table",
    icon: Table2,
    onSelect: () => undefined,
  },
  {
    id: "toggle-list",
    label: "Table",
    icon: Table2,
    onSelect: () => undefined,
  },
  {
    id: "calendar",
    label: "Calendar",
    icon: CalendarDays,
    onSelect: () => undefined,
  },
];

const BASE_PROPS = {
  items: ITEMS,
  searchShortcutLabel: "Ctrl+F",
  taskSearchInputRef: createRef<HTMLInputElement>(),
  rulesView: null,
  dbViewPrefs: null,
  availableTags: [],
  onUpdateDbViewPrefs: null,
  onSearchQueryChange: () => undefined,
  onOpenTaskSearch: () => undefined,
  onCloseTaskSearch: () => undefined,
};

describe("DbViewToolbar", () => {
  test("clear action always closes the inline search and clears active queries", async () => {
    const { resolveDbViewToolbarClearAction } = await import("./db-view-toolbar");

    const emptyAction = resolveDbViewToolbarClearAction(false);
    expect(emptyAction.shouldClear).toBeFalse();
    expect(emptyAction.shouldClose).toBeTrue();

    const activeAction = resolveDbViewToolbarClearAction(true);
    expect(activeAction.shouldClear).toBeTrue();
    expect(activeAction.shouldClose).toBeTrue();
  });

  test("renders database view tabs and the idle search trigger", async () => {
    const { DB_VIEW_TOOLBAR_TEST_ID, DbViewToolbar } = await import("./db-view-toolbar");
    const markup = renderToStaticMarkup(
      createElement(DbViewToolbar, {
        ...BASE_PROPS,
        activeSearchQuery: "",
        taskSearchOpen: false,
      }),
    );

    expect(markup.includes(`data-testid="${DB_VIEW_TOOLBAR_TEST_ID}"`)).toBeTrue();
    expect(markup.includes("aria-label=\"Database views\"")).toBeTrue();
    expect(markup.includes("Board")).toBeTrue();
    expect((markup.match(/aria-label=\"Table\"/g) ?? []).length).toBe(2);
    expect(markup.includes("Calendar")).toBeTrue();
    expect((markup.match(/data-tab-label-visible=\"true\"/g) ?? []).length).toBe(1);
    expect(markup.includes("aria-label=\"Search\"")).toBeTrue();
    expect(markup.includes("aria-hidden=\"true\"")).toBeTrue();
  });

  test("renders the inline search field when open or when a query is active", async () => {
    const { DbViewToolbar } = await import("./db-view-toolbar");
    const openMarkup = renderToStaticMarkup(
      createElement(DbViewToolbar, {
        ...BASE_PROPS,
        activeSearchQuery: "bugfix",
        taskSearchOpen: true,
      }),
    );

    expect(openMarkup.includes("aria-hidden=\"false\"")).toBeTrue();
    expect(openMarkup.includes("Type to search...")).toBeTrue();
    expect(openMarkup.includes("Clear search")).toBeTrue();
    expect(openMarkup.includes("bugfix")).toBeTrue();

    const filteredMarkup = renderToStaticMarkup(
      createElement(DbViewToolbar, {
        ...BASE_PROPS,
        activeSearchQuery: "bugfix",
        taskSearchOpen: false,
      }),
    );

    expect(filteredMarkup.includes("aria-hidden=\"false\"")).toBeTrue();
    expect(filteredMarkup.includes("Type to search...")).toBeTrue();
    expect(filteredMarkup.includes("bugfix")).toBeTrue();
  });

  test("renders the active rules summary row for supported views", async () => {
    const { DbViewToolbar } = await import("./db-view-toolbar");
    const { getDefaultDbViewPrefs } = await import("../../lib/db-view-prefs");
    const prefs = getDefaultDbViewPrefs("kanban");
    prefs.rules.filter.any[0]!.all[0] = {
      field: "status",
      op: "in",
      values: ["backlog", "in_progress"],
    };

    const markup = renderToStaticMarkup(
      createElement(DbViewToolbar, {
        ...BASE_PROPS,
        activeSearchQuery: "",
        taskSearchOpen: false,
        rulesView: "kanban",
        dbViewPrefs: prefs,
        onUpdateDbViewPrefs: () => undefined,
      }),
    );

    expect(markup.includes("Board Order")).toBeTrue();
    expect(markup.includes("Status")).toBeTrue();
    expect(markup.includes("Status:</span>")).toBeTrue();
    expect(markup.includes("Backlog, In Progress")).toBeTrue();
    expect(markup.includes("Ascending")).toBeFalse();
  });

  test("collapses multiple active sorts into a single count chip", async () => {
    const { DbViewToolbar } = await import("./db-view-toolbar");
    const { getDefaultDbViewPrefs } = await import("../../lib/db-view-prefs");
    const prefs = getDefaultDbViewPrefs("toggle-list");
    prefs.rules.sort = [
      { field: "priority", direction: "asc" },
      { field: "estimate", direction: "desc" },
    ];
    prefs.rules.filter.any[0]!.all[1] = {
      field: "priority",
      op: "in",
      values: ["p0-critical", "p1-high"],
    };

    const markup = renderToStaticMarkup(
      createElement(DbViewToolbar, {
        ...BASE_PROPS,
        activeSearchQuery: "",
        taskSearchOpen: false,
        rulesView: "toggle-list",
        dbViewPrefs: prefs,
        onUpdateDbViewPrefs: () => undefined,
      }),
    );

    expect(markup.includes("2 sorts")).toBeTrue();
    expect(markup.includes("Priority")).toBeTrue();
    expect(markup.includes("Priority:</span>")).toBeTrue();
    expect(markup.includes("P0, P1")).toBeTrue();
    expect(markup.includes("Ascending")).toBeFalse();
    expect(markup.includes("Descending")).toBeFalse();
  });

  test("renders empty priority in the summary row when selected explicitly", async () => {
    const { DbViewToolbar } = await import("./db-view-toolbar");
    const { getDefaultDbViewPrefs } = await import("../../lib/db-view-prefs");
    const prefs = getDefaultDbViewPrefs("toggle-list");
    prefs.rules.filter.any[0]!.all[1] = {
      field: "priority",
      op: "in",
      values: ["p0-critical"],
      includeEmpty: true,
    };

    const markup = renderToStaticMarkup(
      createElement(DbViewToolbar, {
        ...BASE_PROPS,
        activeSearchQuery: "",
        taskSearchOpen: false,
        rulesView: "toggle-list",
        dbViewPrefs: prefs,
        onUpdateDbViewPrefs: () => undefined,
      }),
    );

    expect(markup.includes("Priority:</span>")).toBeTrue();
    expect(markup.includes("P0, -")).toBeTrue();
  });
});
