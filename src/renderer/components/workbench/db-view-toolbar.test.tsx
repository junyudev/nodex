import { CanvasIcon, BoardIcon, DatabaseIcon } from "@/components/shared/icons";
import { describe, expect, test, vi } from "vite-plus/test";
import { createRef } from "react";
import { fireEvent } from "@testing-library/react";
import { act } from "react";

import { render, textContent } from "../../test/dom";

type DbViewToolbarItem = {
  id: string;
  label: string;
  icon?: typeof BoardIcon;
  active?: boolean;
  onSelect: () => void;
};

const ITEMS: DbViewToolbarItem[] = [
  {
    id: "board",
    label: "Board",
    icon: BoardIcon,
    active: true,
    onSelect: () => undefined,
  },
  {
    id: "list",
    label: "List",
    icon: DatabaseIcon,
    onSelect: () => undefined,
  },
];

const BASE_PROPS = {
  items: ITEMS,
  searchShortcutLabel: "Ctrl+F",
  taskSearchInputRef: createRef<HTMLInputElement>(),
  onSearchQueryChange: () => undefined,
  onOpenTaskSearch: () => undefined,
  onCloseTaskSearch: () => undefined,
};

describe("DbViewToolbar", () => {
  test("clear action always closes the inline search and clears active queries", async () => {
    const { resolveDbViewToolbarClearAction } = await import("./db-view-toolbar");

    const emptyAction = resolveDbViewToolbarClearAction(false);
    expect(emptyAction.shouldClear).toBe(false);
    expect(emptyAction.shouldClose).toBe(true);

    const activeAction = resolveDbViewToolbarClearAction(true);
    expect(activeAction.shouldClear).toBe(true);
    expect(activeAction.shouldClose).toBe(true);
  });

  test("renders database view tabs and the idle search trigger", async () => {
    const { DB_VIEW_TOOLBAR_TEST_ID, DbViewToolbar } = await import("./db-view-toolbar");
    const { container, getByLabelText, getByText, getByTestId } = render(
      <DbViewToolbar {...BASE_PROPS} activeSearchQuery="" taskSearchOpen={false} />,
    );

    expect(getByTestId(DB_VIEW_TOOLBAR_TEST_ID).getAttribute("data-testid")).toBe(
      DB_VIEW_TOOLBAR_TEST_ID,
    );
    expect(getByLabelText("Database views").getAttribute("aria-label")).toBe("Database views");
    expect(getByText("Board").textContent).toBe("Board");
    expect(getByText("List").textContent).toBe("List");
    expect(container.querySelectorAll('[data-tab-label-visible="true"]').length).toBe(2);
    expect(getByLabelText("Search").getAttribute("aria-label")).toBe("Search");
    expect(
      getByTestId(DB_VIEW_TOOLBAR_TEST_ID).querySelector('[aria-hidden="true"]') !== null,
    ).toBe(true);
  });

  test("renders Canvas as an adjacent destination action, not a Database tab", async () => {
    const onOpenCanvas = vi.fn();
    const { DbViewToolbar } = await import("./db-view-toolbar");
    const { getByLabelText } = render(
      <DbViewToolbar
        {...BASE_PROPS}
        destinationItems={[
          {
            id: "primary-canvas",
            label: "Canvas",
            icon: CanvasIcon,
            onSelect: onOpenCanvas,
          },
        ]}
        activeSearchQuery=""
        taskSearchOpen={false}
      />,
    );

    const canvas = getByLabelText("Canvas");
    expect(canvas.getAttribute("role")).not.toBe("tab");
    fireEvent.click(canvas);
    expect(onOpenCanvas).toHaveBeenCalledOnce();
  });

  test("renders the inline search field when open or when a query is active", async () => {
    const { DbViewToolbar } = await import("./db-view-toolbar");
    const openRender = render(
      <DbViewToolbar {...BASE_PROPS} activeSearchQuery="bugfix" taskSearchOpen />,
    );

    expect(openRender.container.querySelector('[aria-hidden="false"]') !== null).toBe(true);
    expect(openRender.getByPlaceholderText("Type to search...").getAttribute("placeholder")).toBe(
      "Type to search...",
    );
    expect(openRender.getByLabelText("Clear search").getAttribute("aria-label")).toBe(
      "Clear search",
    );
    expect(openRender.getByDisplayValue("bugfix").getAttribute("value")).toBe("bugfix");

    openRender.unmount();

    const filteredRender = render(
      <DbViewToolbar {...BASE_PROPS} activeSearchQuery="bugfix" taskSearchOpen={false} />,
    );

    expect(filteredRender.container.querySelector('[aria-hidden="false"]') !== null).toBe(true);
    expect(
      filteredRender.getByPlaceholderText("Type to search...").getAttribute("placeholder"),
    ).toBe("Type to search...");
    expect(filteredRender.getByDisplayValue("bugfix").getAttribute("value")).toBe("bugfix");
  });

  test("hides search controls when the active view owns the toolbar cluster", async () => {
    const { DbViewToolbar } = await import("./db-view-toolbar");
    const { container } = render(
      <DbViewToolbar
        {...BASE_PROPS}
        activeSearchQuery="bugfix"
        taskSearchOpen
        showSearchControls={false}
      />,
    );

    expect(container.querySelector('[aria-label="Search"]') === null).toBe(true);
    expect(container.querySelector('[aria-label="Search tasks"]') === null).toBe(true);
    expect(textContent(container).includes("bugfix")).toBe(false);
  });

  test("renders durable Filter and Display controls supplied by the View runtime", async () => {
    const { DbViewToolbar } = await import("./db-view-toolbar");
    const { getByRole } = render(
      <DbViewToolbar
        {...BASE_PROPS}
        activeSearchQuery=""
        taskSearchOpen={false}
        databaseViewControls={
          <>
            <button type="button">Filter View</button>
            <button type="button">Display options</button>
          </>
        }
      />,
    );

    expect(getByRole("button", { name: "Filter View" })).toBeTruthy();
    expect(getByRole("button", { name: "Display options" })).toBeTruthy();
  });

  test("opens the active View menu on click and keeps inactive clicks as selection", async () => {
    const onSelectList = vi.fn();
    const onRename = vi.fn();
    const onDisplayModeChange = vi.fn();
    const { DbViewToolbar } = await import("./db-view-toolbar");
    const actionMenu = {
      viewId: "board",
      viewName: "Board",
      viewIcon: BoardIcon,
      dataSourceName: "Tasks",
      displayMode: "icon_and_text" as const,
      busy: false,
      canDelete: true,
      onRename,
      onEdit: vi.fn(),
      onOpenSource: vi.fn(),
      onCopyLink: vi.fn(),
      onDuplicate: vi.fn(),
      onRequestDelete: vi.fn(),
      onDisplayModeChange,
    };
    const view = render(
      <DbViewToolbar
        {...BASE_PROPS}
        items={[
          { ...ITEMS[0]!, actionMenu },
          {
            ...ITEMS[1]!,
            onSelect: onSelectList,
            actionMenu: { ...actionMenu, viewId: "list", viewName: "List" },
          },
        ]}
        activeSearchQuery=""
        taskSearchOpen={false}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "Board" }));
      await Promise.resolve();
    });
    expect(view.getByRole("menu")).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Rename" }));
      await Promise.resolve();
    });
    expect(onRename).toHaveBeenCalledOnce();

    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "List" }));
      await Promise.resolve();
    });
    expect(onSelectList).toHaveBeenCalledOnce();
    expect(view.queryByRole("menu")).toBeNull();
  });

  test("targets a right-clicked View and applies its personal display mode", async () => {
    const onDisplayModeChange = vi.fn();
    const onDuplicateList = vi.fn();
    const { DbViewToolbar } = await import("./db-view-toolbar");
    const actionMenu = {
      viewId: "board",
      viewName: "Board",
      viewIcon: BoardIcon,
      dataSourceName: "Tasks",
      displayMode: "icon_and_text" as const,
      busy: false,
      canDelete: true,
      onRename: vi.fn(),
      onEdit: vi.fn(),
      onOpenSource: vi.fn(),
      onCopyLink: vi.fn(),
      onDuplicate: vi.fn(),
      onRequestDelete: vi.fn(),
      onDisplayModeChange,
    };
    const view = render(
      <DbViewToolbar
        {...BASE_PROPS}
        items={[
          { ...ITEMS[0]!, actionMenu },
          {
            ...ITEMS[1]!,
            actionMenu: {
              ...actionMenu,
              viewId: "list",
              viewName: "List",
              onDuplicate: onDuplicateList,
            },
          },
        ]}
        activeSearchQuery=""
        taskSearchOpen={false}
      />,
    );

    await act(async () => {
      fireEvent.contextMenu(view.getByRole("tab", { name: "List" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Duplicate view" }));
      await Promise.resolve();
    });
    expect(onDuplicateList).toHaveBeenCalledOnce();

    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "Board" }));
      await Promise.resolve();
      fireEvent.pointerMove(view.getByText("Display as"), { pointerType: "mouse" });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Icon only" }));
      await Promise.resolve();
    });
    expect(onDisplayModeChange).toHaveBeenCalledWith("icon_only");
  });
});
