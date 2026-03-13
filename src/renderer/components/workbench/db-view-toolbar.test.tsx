import { describe, expect, mock, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarDays, List, SquareKanban } from "lucide-react";

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
    icon: List,
    onSelect: () => undefined,
  },
  {
    id: "toggle-list",
    label: "Table",
    icon: List,
    onSelect: () => undefined,
  },
  {
    id: "calendar",
    label: "Calendar",
    icon: CalendarDays,
    onSelect: () => undefined,
  },
];

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
        items: ITEMS,
        activeSearchQuery: "",
        taskSearchOpen: false,
        searchShortcutLabel: "Ctrl+F",
        taskSearchInputRef: createRef<HTMLInputElement>(),
        onSearchQueryChange: () => undefined,
        onOpenTaskSearch: () => undefined,
        onCloseTaskSearch: () => undefined,
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
        items: ITEMS,
        activeSearchQuery: "bugfix",
        taskSearchOpen: true,
        searchShortcutLabel: "Ctrl+F",
        taskSearchInputRef: createRef<HTMLInputElement>(),
        onSearchQueryChange: () => undefined,
        onOpenTaskSearch: () => undefined,
        onCloseTaskSearch: () => undefined,
      }),
    );

    expect(openMarkup.includes("aria-hidden=\"false\"")).toBeTrue();
    expect(openMarkup.includes("Type to search...")).toBeTrue();
    expect(openMarkup.includes("Clear search")).toBeTrue();
    expect(openMarkup.includes("bugfix")).toBeTrue();

    const filteredMarkup = renderToStaticMarkup(
      createElement(DbViewToolbar, {
        items: ITEMS,
        activeSearchQuery: "bugfix",
        taskSearchOpen: false,
        searchShortcutLabel: "Ctrl+F",
        taskSearchInputRef: createRef<HTMLInputElement>(),
        onSearchQueryChange: () => undefined,
        onOpenTaskSearch: () => undefined,
        onCloseTaskSearch: () => undefined,
      }),
    );

    expect(filteredMarkup.includes("aria-hidden=\"false\"")).toBeTrue();
    expect(filteredMarkup.includes("Type to search...")).toBeTrue();
    expect(filteredMarkup.includes("bugfix")).toBeTrue();
  });
});
