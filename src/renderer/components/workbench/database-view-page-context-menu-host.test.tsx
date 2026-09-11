import { act, fireEvent, waitFor } from "@testing-library/react";
import { NodexModalHost } from "@/lib/modal-registry";
import { createRef } from "react";
import { describe, expect, test, vi } from "vite-plus/test";

import { dataSourcePagePropertyMenuSourceFromBindings } from "@/components/database/data-source-page-property-menu-source";
import { renderWithMaitai as render } from "@/test/thread-maitai";
import type { DatabaseViewPageMenuSession } from "./database-view-page-context-menu";
import { DatabaseViewPageContextMenuHost } from "./database-view-page-context-menu-host";

vi.mock("@/components/board/editor/nfm-send-to-thread-menu", () => ({
  NfmSendToThreadMenu: ({
    onAccept,
  }: {
    readonly onAccept: (request: { target: { kind: "new-thread" }; mode: "send" }) => Promise<void>;
  }) => (
    <button onClick={() => onAccept({ target: { kind: "new-thread" }, mode: "send" })}>
      Choose chat
    </button>
  ),
}));

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
  test("keeps the chat chooser alive after its menu and View unmount", async () => {
    const sendToChat = vi.fn().mockResolvedValue(undefined);
    const ancestorPointerDown = vi.fn();
    const renderHost = (visible: boolean) => (
      <>
        <NodexModalHost />
        {visible ? (
          <div onPointerDown={ancestorPointerDown}>
            <DatabaseViewPageContextMenuHost
              resolveSession={(key) => ({ ...session(key), actionPort: { sendToChat } })}
            >
              <button data-database-view-page-menu-target="page-1">Page</button>
            </DatabaseViewPageContextMenuHost>
          </div>
        ) : null}
      </>
    );
    const view = render(renderHost(true));
    await act(async () => {
      fireEvent.contextMenu(view.getByRole("button", { name: "Page" }), {
        clientX: 80,
        clientY: 60,
      });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.pointerMove(await view.findByRole("menuitem", { name: "Open in" }), {
        pointerType: "mouse",
      });
      await Promise.resolve();
    });
    const send = await view.findByRole("menuitem", { name: "Send to chat…" });
    await act(async () => {
      fireEvent.click(send);
      await Promise.resolve();
    });
    const choose = await view.findByRole("button", { name: "Choose chat" });
    await waitFor(() =>
      expect(
        view.queryByRole("textbox", { name: "Search Page actions and properties" }),
      ).toBeNull(),
    );
    await act(async () => {
      fireEvent.pointerDown(choose);
      await Promise.resolve();
    });
    expect(ancestorPointerDown).not.toHaveBeenCalled();
    view.rerender(renderHost(false));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Choose chat" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(sendToChat).toHaveBeenCalledWith({
        projectId: "project-1",
        pageId: "page-1",
        pageKey: "PAGE-1",
        titleSnapshot: "Page page-1",
        target: { kind: "new-thread" },
      }),
    );
    await waitFor(() => expect(view.queryByRole("button", { name: "Choose chat" })).toBeNull());
  });

  test("returns focus to the surviving View when a menu action removes its Page target", async () => {
    const returnFocusRef = createRef<HTMLDivElement>();
    const renderHost = (showPage: boolean) => (
      <DatabaseViewPageContextMenuHost resolveSession={session} returnFocusRef={returnFocusRef}>
        <div ref={returnFocusRef} tabIndex={0}>
          {showPage ? (
            <button type="button" data-database-view-page-menu-target="page-1">
              Page
            </button>
          ) : null}
          <button type="button">Another Page</button>
        </div>
      </DatabaseViewPageContextMenuHost>
    );
    const view = render(renderHost(true));
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
    await waitFor(() => expect(search).toBe(document.activeElement));
    view.rerender(renderHost(false));
    await act(async () => {
      fireEvent.keyDown(search, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.activeElement).toBe(returnFocusRef.current));
  });

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
