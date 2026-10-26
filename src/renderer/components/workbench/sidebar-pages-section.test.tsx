import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  LibraryNavigationNode,
  LibraryPageNavigationNode,
} from "../../../shared/library-module";
import { parseDatabaseId, parseDatabaseViewId } from "../../../shared/database-identities";
import { renderWithMaitai } from "@/test/thread-maitai";
import { PageTitleProjectionProvider } from "@/lib/page-title-projection-context";
import {
  createPageTitleProjectionStore,
  makePageTitleResourceKey,
} from "@/lib/page-title-projection-store";
import { SidebarPagesSection, type SidebarPagesDataSource } from "./sidebar-pages-section";

const mockLibraryChildren = vi.hoisted(() => vi.fn());

vi.mock("@/lib/use-library-navigation", () => ({
  useInfiniteLibraryChildren: mockLibraryChildren,
  useApplyLibraryOperation: () => ({
    mutation: { mutateAsync: vi.fn(), isPending: false },
  }),
  useUndoLibraryPageRelocation: () => vi.fn(),
  useLibraryPageRelocationDestinations: () => ({
    data: { items: [], hasMore: false },
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useLibraryPageRelocationChildren: () => [],
}));

vi.mock("@/lib/interactive-page-search", () => ({
  configuredPageSearchProjectIds: () => [],
  useInteractivePageSearch: () => ({ rows: [], enrichment: "idle", queryRevision: "" }),
}));

const makePage = (index: number): LibraryPageNavigationNode => ({
  kind: "page",
  pageId: `page:${index}`,
  title: `Page ${index}`,
  hasChildren: false,
  parentRevision: 1,
  metadataRevision: 1,
  documentGeneration: 1,
  documentHeadSeq: 0,
  updatedAt: "2026-08-03T00:00:00.000Z",
});

const dataSource = (items: readonly LibraryNavigationNode[]): SidebarPagesDataSource => ({
  useRoots: () => ({
    data: {
      pages: [
        {
          kind: "children",
          parent: { kind: "library" },
          items,
          nextCursor: null,
          hasMore: false,
          total: items.length,
        },
      ],
    },
    isPending: false,
    isError: false,
    hasNextPage: false,
    refetch: vi.fn(async () => undefined),
    fetchNextPage: vi.fn(async () => undefined),
  }),
});

beforeEach(() => mockLibraryChildren.mockReset());

describe("SidebarPagesSection", () => {
  test("reads the complete Library root projection and force-includes the selected root", () => {
    mockLibraryChildren.mockImplementation(() => dataSource([makePage(1)]).useRoots({}));
    const activeRoot = { kind: "page", pageId: "page:1" } as const;
    renderWithMaitai(
      <SidebarPagesSection
        collapsed={false}
        activeRoot={activeRoot}
        onToggle={vi.fn()}
        onOpenRoot={vi.fn()}
        mutationsEnabled={false}
      />,
    );

    expect(mockLibraryChildren).toHaveBeenCalledWith(
      { kind: "library" },
      {
        limit: 10,
        forceIncludeTarget: activeRoot,
      },
    );
  });

  test("opens Project primary Databases and Canvases through their Library targets", async () => {
    const databaseId = parseDatabaseId("database:alpha");
    const onOpenRoot = vi.fn();
    const nodes: LibraryNavigationNode[] = [
      {
        kind: "database",
        databaseId,
        title: "Project Database",
        defaultViewId: parseDatabaseViewId("view:alpha"),
        hasMultipleViews: false,
        isPrimary: true,
        metadataRevision: 1,
        locationRevision: 2,
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        kind: "canvas",
        canvasId: "canvas:primary:alpha",
        title: "Project Canvas",
        isPrimary: true,
        metadataRevision: 1,
        locationRevision: 2,
        documentGeneration: 1,
        documentHeadSeq: 0,
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ];
    renderWithMaitai(
      <SidebarPagesSection
        collapsed={false}
        activeRoot={{ kind: "database", databaseId }}
        onToggle={vi.fn()}
        onOpenRoot={onOpenRoot}
        dataSource={dataSource(nodes)}
        mutationsEnabled={false}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Project Database"));
      fireEvent.click(screen.getByText("Project Canvas"));
      await Promise.resolve();
    });
    expect(onOpenRoot.mock.calls).toEqual([
      [{ kind: "database", databaseId }],
      [{ kind: "canvas", canvasId: "canvas:primary:alpha" }],
    ]);
  });

  test("shows a complete small root set without a pager", () => {
    renderWithMaitai(
      <SidebarPagesSection
        collapsed={false}
        activeRoot={{ kind: "page", pageId: "page:2" }}
        onToggle={vi.fn()}
        onOpenRoot={vi.fn()}
        dataSource={dataSource([makePage(1), makePage(2), makePage(3)])}
        mutationsEnabled={false}
      />,
    );

    const list = screen.getByRole("list", { name: "Content" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.getByText("Page 2").closest("[data-active]")?.getAttribute("data-active")).toBe(
      "true",
    );
  });

  test("uses the shared Show more and Show less paging behavior", async () => {
    renderWithMaitai(
      <SidebarPagesSection
        collapsed={false}
        activeRoot={null}
        onToggle={vi.fn()}
        onOpenRoot={vi.fn()}
        dataSource={dataSource(Array.from({ length: 6 }, (_, index) => makePage(index + 1)))}
        mutationsEnabled={false}
      />,
    );

    expect(screen.queryByText("Page 6")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      await Promise.resolve();
    });
    expect(await screen.findByText("Page 6")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Show less" })).not.toBeNull();
  });

  test("opens a Page's shared resource menu from the whole row context target", async () => {
    const onOpenRoot = vi.fn();
    const onHoverSurfaceOpenChange = vi.fn();
    renderWithMaitai(
      <SidebarPagesSection
        collapsed={false}
        activeRoot={null}
        onToggle={vi.fn()}
        onOpenRoot={onOpenRoot}
        dataSource={dataSource([makePage(1)])}
        mutationsEnabled
        onHoverSurfaceOpenChange={onHoverSurfaceOpenChange}
      />,
    );

    const row = screen.getByText("Page 1").closest<HTMLElement>("[role='listitem']");
    if (!row) throw new Error("Expected Sidebar Page row");
    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 120, clientY: 80 });
      await Promise.resolve();
    });

    expect(await screen.findByRole("menuitem", { name: "Move to" })).not.toBeNull();
    expect(onHoverSurfaceOpenChange).toHaveBeenLastCalledWith(true);
    expect(onOpenRoot).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => expect(onHoverSurfaceOpenChange).toHaveBeenLastCalledWith(false));
  });

  test("offers Archive for an ordinary Database but not for a primary one", async () => {
    const database = (title: string, isPrimary: boolean): LibraryNavigationNode => ({
      kind: "database",
      databaseId: parseDatabaseId(`database:${title}`),
      title,
      defaultViewId: parseDatabaseViewId(`view:${title}`),
      hasMultipleViews: false,
      isPrimary,
      metadataRevision: 1,
      locationRevision: 1,
      updatedAt: "2026-10-26T00:00:00.000Z",
    });
    renderWithMaitai(
      <SidebarPagesSection
        collapsed={false}
        activeRoot={null}
        onToggle={vi.fn()}
        onOpenRoot={vi.fn()}
        dataSource={dataSource([database("Reading", false), database("Inbox", true)])}
        mutationsEnabled
      />,
    );
    const menuItems = async (title: string) => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }));
        await Promise.resolve();
      });
      const menu = await screen.findByRole("menu");
      const names = within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent?.trim());
      await act(async () => {
        fireEvent.keyDown(menu, { key: "Escape" });
        await Promise.resolve();
      });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      return names;
    };

    expect(await menuItems("Reading")).toContain("Archive");
    const primary = await menuItems("Inbox");
    expect(primary).toContain("Move to");
    expect(primary).not.toContain("Archive");
  });

  test("only an open resource menu releases floating sidebar ownership when rows unmount", async () => {
    const onHoverSurfaceOpenChange = vi.fn();
    const props = {
      collapsed: false,
      activeRoot: null,
      onToggle: vi.fn(),
      onOpenRoot: vi.fn(),
      mutationsEnabled: true,
      onHoverSurfaceOpenChange,
    };
    const view = renderWithMaitai(
      <SidebarPagesSection {...props} dataSource={dataSource([makePage(1), makePage(2)])} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Actions for Page 2" }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("menuitem", { name: "Move to" })).not.toBeNull();
    expect(onHoverSurfaceOpenChange).toHaveBeenLastCalledWith(true);

    view.rerender(<SidebarPagesSection {...props} dataSource={dataSource([makePage(2)])} />);
    await waitFor(() => expect(screen.queryByText("Page 1")).toBeNull());
    expect(onHoverSurfaceOpenChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });
    expect(onHoverSurfaceOpenChange).toHaveBeenLastCalledWith(false);
  });

  test("keeps the selected root visible outside the collapsed page window", () => {
    renderWithMaitai(
      <SidebarPagesSection
        collapsed={false}
        activeRoot={{ kind: "page", pageId: "page:6" }}
        onToggle={vi.fn()}
        onOpenRoot={vi.fn()}
        dataSource={dataSource(Array.from({ length: 6 }, (_, index) => makePage(index + 1)))}
        mutationsEnabled={false}
      />,
    );
    expect(screen.getByText("Page 6").closest("[aria-current]")?.getAttribute("aria-current")).toBe(
      "page",
    );
  });

  test("requests the next bounded root window from Show more", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    const source: SidebarPagesDataSource = {
      useRoots: () => ({
        ...dataSource([makePage(1)]).useRoots({}),
        hasNextPage: true,
        fetchNextPage,
      }),
    };
    renderWithMaitai(
      <SidebarPagesSection
        collapsed={false}
        activeRoot={null}
        onToggle={vi.fn()}
        onOpenRoot={vi.fn()}
        dataSource={source}
        mutationsEnabled={false}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchNextPage).toHaveBeenCalledTimes(1));
  });

  test("projects a mounted Page's live title without changing its resource identity", async () => {
    const store = createPageTitleProjectionStore();
    const onOpenRoot = vi.fn();
    renderWithMaitai(
      <PageTitleProjectionProvider currentLibraryId="library-a" store={store}>
        <SidebarPagesSection
          collapsed={false}
          activeRoot={null}
          onToggle={vi.fn()}
          onOpenRoot={onOpenRoot}
          dataSource={dataSource([makePage(1)])}
          mutationsEnabled={false}
        />
      </PageTitleProjectionProvider>,
    );
    await act(async () => {
      store.publishLive(
        makePageTitleResourceKey("library-a", "page:1"),
        "editor-a",
        "Edited title",
        1,
      );
      await Promise.resolve();
    });
    const title = await screen.findByText("Edited title");
    await act(async () => {
      fireEvent.click(title);
      await Promise.resolve();
    });
    expect(onOpenRoot).toHaveBeenCalledWith({ kind: "page", pageId: "page:1" });
  });
});
