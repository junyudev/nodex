import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { dataSourcePagePropertyMenuSourceFromBindings } from "@/components/database/data-source-page-property-menu-source";
import { render } from "@/test/dom";
import type { DatabaseViewPageMenuSession } from "./database-view-page-context-menu";
import { DatabaseViewPageContextMenuHost } from "./database-view-page-context-menu-host";

const session = (pageId: string): DatabaseViewPageMenuSession => ({
  page: {
    libraryId: "library-1",
    accessContext: { kind: "project", projectId: "project-1" },
    projectId: "project-1",
    pageId,
    pageKey: pageId.toUpperCase(),
    titleSnapshot: `Page ${pageId}`,
  },
  canMoveUp: true,
  canMoveDown: true,
  propertySource: dataSourcePagePropertyMenuSourceFromBindings([]),
  actionPort: {},
  onReorder: () => undefined,
});

describe("DatabaseViewPageContextMenuHost", () => {
  test("opens one View-owned menu for the Page target without rerendering rows", async () => {
    const resolveSession = vi.fn((targetKey: string) => session(targetKey));
    const renderRows = vi.fn();
    function Rows() {
      renderRows();
      return (
        <div>
          <button type="button" data-database-view-page-menu-target="page-1">
            First Page
          </button>
          <button type="button" data-database-view-page-menu-target="page-2">
            Second Page
          </button>
        </div>
      );
    }
    const view = render(
      <DatabaseViewPageContextMenuHost resolveSession={resolveSession}>
        <Rows />
      </DatabaseViewPageContextMenuHost>,
    );

    await act(async () => {
      fireEvent.contextMenu(view.getByRole("button", { name: "Second Page" }), {
        clientX: 80,
        clientY: 60,
      });
      await Promise.resolve();
    });

    await view.findByRole("textbox", { name: "Search Page actions and properties" });
    expect(resolveSession).toHaveBeenCalledWith("page-2");
    expect(renderRows).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-slot="context-menu-content"]')).toHaveLength(1);
  });

  test("does not open the Page menu from View whitespace", async () => {
    const resolveSession = vi.fn((targetKey: string) => session(targetKey));
    const view = render(
      <DatabaseViewPageContextMenuHost resolveSession={resolveSession}>
        <div>
          <button type="button">View whitespace</button>
        </div>
      </DatabaseViewPageContextMenuHost>,
    );

    await act(async () => {
      fireEvent.contextMenu(view.getByRole("button", { name: "View whitespace" }), {
        clientX: 80,
        clientY: 60,
      });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        view.queryByRole("textbox", { name: "Search Page actions and properties" }),
      ).toBeNull(),
    );
    expect(resolveSession).not.toHaveBeenCalled();
  });

  test("resets search and focus after root dismissal", async () => {
    const resolveSession = vi.fn((targetKey: string) => session(targetKey));
    const view = render(
      <DatabaseViewPageContextMenuHost resolveSession={resolveSession}>
        <button type="button" data-database-view-page-menu-target="page-1">
          Page
        </button>
      </DatabaseViewPageContextMenuHost>,
    );

    await act(async () => {
      fireEvent.contextMenu(view.getByRole("button", { name: "Page" }), {
        clientX: 80,
        clientY: 60,
      });
      await Promise.resolve();
    });
    const search = await view.findByRole("textbox", {
      name: "Search Page actions and properties",
    });
    await act(async () => {
      fireEvent.change(search, { target: { value: "copy" } });
      await Promise.resolve();
    });
    await waitFor(() => expect((search as HTMLInputElement).value).toBe("copy"));

    await act(async () => {
      fireEvent.keyDown(search, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        view.queryByRole("textbox", {
          name: "Search Page actions and properties",
        }),
      ).toBeNull(),
    );

    await act(async () => {
      fireEvent.contextMenu(view.getByRole("button", { name: "Page" }), {
        clientX: 80,
        clientY: 60,
      });
      await Promise.resolve();
    });
    const reopenedSearch = await view.findByRole("textbox", {
      name: "Search Page actions and properties",
    });
    expect((reopenedSearch as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(reopenedSearch).toBe(document.activeElement));
  });
});
