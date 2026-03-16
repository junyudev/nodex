import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { CalendarDays, SquareKanban, Table2 } from "lucide-react";
import { render, textContent } from "../../test/dom";

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
    const { container, getByLabelText, getByText, getByTestId } = render(
      <DbViewToolbar
        {...BASE_PROPS}
        activeSearchQuery=""
        taskSearchOpen={false}
      />,
    );

    expect(getByTestId(DB_VIEW_TOOLBAR_TEST_ID).getAttribute("data-testid")).toBe(DB_VIEW_TOOLBAR_TEST_ID);
    expect(getByLabelText("Database views").getAttribute("aria-label")).toBe("Database views");
    expect(getByText("Board").textContent).toBe("Board");
    expect(container.querySelectorAll('[aria-label="Table"]').length).toBe(2);
    expect(getByText("Calendar").textContent).toBe("Calendar");
    expect(container.querySelectorAll('[data-tab-label-visible="true"]').length).toBe(1);
    expect(getByLabelText("Search").getAttribute("aria-label")).toBe("Search");
    expect(getByTestId(DB_VIEW_TOOLBAR_TEST_ID).innerHTML.includes('aria-hidden="true"')).toBeTrue();
  });

  test("renders the inline search field when open or when a query is active", async () => {
    const { DbViewToolbar } = await import("./db-view-toolbar");
    const openRender = render(
      <DbViewToolbar
        {...BASE_PROPS}
        activeSearchQuery="bugfix"
        taskSearchOpen
      />,
    );

    expect(openRender.container.innerHTML.includes('aria-hidden="false"')).toBeTrue();
    expect(openRender.getByPlaceholderText("Type to search...").getAttribute("placeholder")).toBe("Type to search...");
    expect(openRender.getByLabelText("Clear search").getAttribute("aria-label")).toBe("Clear search");
    expect(openRender.getByDisplayValue("bugfix").getAttribute("value")).toBe("bugfix");

    openRender.unmount();

    const filteredRender = render(
      <DbViewToolbar
        {...BASE_PROPS}
        activeSearchQuery="bugfix"
        taskSearchOpen={false}
      />,
    );

    expect(filteredRender.container.innerHTML.includes('aria-hidden="false"')).toBeTrue();
    expect(filteredRender.getByPlaceholderText("Type to search...").getAttribute("placeholder")).toBe("Type to search...");
    expect(filteredRender.getByDisplayValue("bugfix").getAttribute("value")).toBe("bugfix");
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

    const { container, getByText } = render(
      <DbViewToolbar
        {...BASE_PROPS}
        activeSearchQuery=""
        taskSearchOpen={false}
        rulesView="kanban"
        dbViewPrefs={prefs}
        onUpdateDbViewPrefs={() => undefined}
      />,
    );

    expect(getByText("Board Order").textContent).toBe("Board Order");
    expect(textContent(container).includes("Status")).toBeTrue();
    expect(textContent(container).includes("Backlog, In Progress")).toBeTrue();
    expect(textContent(container).includes("Ascending")).toBeFalse();
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

    const { container, getByText } = render(
      <DbViewToolbar
        {...BASE_PROPS}
        activeSearchQuery=""
        taskSearchOpen={false}
        rulesView="toggle-list"
        dbViewPrefs={prefs}
        onUpdateDbViewPrefs={() => undefined}
      />,
    );

    expect(getByText("2 sorts").textContent).toBe("2 sorts");
    expect(textContent(container).includes("Priority")).toBeTrue();
    expect(textContent(container).includes("P0, P1")).toBeTrue();
    expect(textContent(container).includes("Ascending")).toBeFalse();
    expect(textContent(container).includes("Descending")).toBeFalse();
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

    const { container } = render(
      <DbViewToolbar
        {...BASE_PROPS}
        activeSearchQuery=""
        taskSearchOpen={false}
        rulesView="toggle-list"
        dbViewPrefs={prefs}
        onUpdateDbViewPrefs={() => undefined}
      />,
    );

    expect(textContent(container).includes("Priority")).toBeTrue();
    expect(textContent(container).includes("P0, -")).toBeTrue();
  });
});
