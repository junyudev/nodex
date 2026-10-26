import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  LibraryNavigationNode,
  LibraryPageNavigationNode,
} from "../../../shared/library-module";
import { parseDatabaseId, parseDatabaseViewId } from "../../../shared/database-identities";
import { renderWithMaitai } from "@/test/thread-maitai";
import { TestQueryProvider } from "@/test/query";
import { PageTitleProjectionProvider } from "@/lib/page-title-projection-context";
import {
  createPageTitleProjectionStore,
  makePageTitleResourceKey,
} from "@/lib/page-title-projection-store";
import {
  SidebarPagesSection,
  type SidebarPagesDataSource,
  type SidebarPagesSectionProps,
} from "./sidebar-pages-section";

const mockLibraryChildren = vi.hoisted(() => vi.fn());
const mockSelectedRootRead = vi.hoisted(() => vi.fn());

vi.mock("@/lib/use-library-navigation", () => ({
  useInfiniteLibraryChildren: mockLibraryChildren,
  libraryChildrenQueryOptions: (_parent: unknown, input: unknown) => ({
    queryKey: ["libraryNavigation", "children", "library", input],
    queryFn: () => mockSelectedRootRead(input),
  }),
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

const pages = (count: number) => Array.from({ length: count }, (_, index) => makePage(index + 1));

const childrenWindow = (items: readonly LibraryNavigationNode[], hasMore: boolean) => ({
  kind: "children" as const,
  parent: { kind: "library" as const },
  items,
  nextCursor: hasMore ? "next" : null,
  hasMore,
  total: items.length,
});

const dataSource = (
  items: readonly LibraryNavigationNode[],
  selected: SidebarPagesDataSource["useSelectedRoot"] = () => null,
): SidebarPagesDataSource => ({
  useRoots: () => ({
    data: { pages: [childrenWindow(items, false)] },
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: vi.fn(async () => undefined),
    fetchNextPage: vi.fn(async () => undefined),
  }),
  useSelectedRoot: selected,
});

/** A Library of `total` roots read in windows of `limit`, like the Core continuation. */
const windowedDataSource = (
  total: number,
  onRead: (loadedWindows: number) => void = () => {},
): SidebarPagesDataSource => ({
  useRoots: ({ limit }) => {
    const [loadedWindows, setLoadedWindows] = useState(1);
    const all = pages(total);
    const windows = Array.from({ length: loadedWindows }, (_, index) =>
      childrenWindow(all.slice(index * limit, (index + 1) * limit), (index + 1) * limit < total),
    );
    return {
      data: { pages: windows },
      isPending: false,
      isError: false,
      hasNextPage: loadedWindows * limit < total,
      isFetchingNextPage: false,
      refetch: vi.fn(async () => undefined),
      fetchNextPage: async () => {
        onRead(loadedWindows + 1);
        setLoadedWindows((current) => current + 1);
      },
    };
  },
  useSelectedRoot: (target) => {
    if (target?.kind !== "page") return null;
    return pages(total).find((page) => page.pageId === target.pageId) ?? null;
  },
});

const contentRowTitles = () =>
  within(screen.getByRole("list", { name: "Content" }))
    .getAllByRole("listitem")
    .map((row) => row.textContent ?? "")
    .filter((title) => title.startsWith("Page "));

/** Holds Content depth the way the Profile preference does for the Workbench. */
function DepthOwner({
  initialExtraPages = 0,
  onExtraPagesChange,
  ...props
}: Omit<SidebarPagesSectionProps, "extraPages" | "onExtraPagesChange"> & {
  readonly initialExtraPages?: number;
  readonly onExtraPagesChange?: (extraPages: number) => void;
}) {
  const [extraPages, setExtraPages] = useState(initialExtraPages);
  return (
    <SidebarPagesSection
      {...props}
      extraPages={extraPages}
      onExtraPagesChange={(next) => {
        onExtraPagesChange?.(next);
        setExtraPages(next);
      }}
    />
  );
}

const baseProps = {
  collapsed: false,
  onToggle: vi.fn(),
  onOpenRoot: vi.fn(),
  mutationsEnabled: false,
  extraPages: 0,
  onExtraPagesChange: vi.fn(),
} satisfies Partial<SidebarPagesSectionProps>;

beforeEach(() => {
  mockLibraryChildren.mockReset();
  mockSelectedRootRead.mockReset();
});

describe("SidebarPagesSection", () => {
  test("reads one Library window identity no matter which root is selected", async () => {
    mockLibraryChildren.mockImplementation(() => ({
      ...windowedDataSource(30).useRoots({ limit: 20 }),
    }));
    mockSelectedRootRead.mockImplementation(async () =>
      childrenWindow([makePage(1), makePage(25)], true),
    );
    const view = renderWithMaitai(
      <TestQueryProvider>
        <SidebarPagesSection {...baseProps} activeRoot={{ kind: "page", pageId: "page:2" }} />
      </TestQueryProvider>,
    );
    view.rerender(
      <TestQueryProvider>
        <SidebarPagesSection {...baseProps} activeRoot={{ kind: "page", pageId: "page:25" }} />
      </TestQueryProvider>,
    );

    expect(await screen.findByText("Page 25")).not.toBeNull();
    expect(new Set(mockLibraryChildren.mock.calls.map((call) => JSON.stringify(call)))).toEqual(
      new Set([JSON.stringify([{ kind: "library" }, { limit: 20 }])]),
    );
    expect(mockSelectedRootRead).toHaveBeenCalledWith({
      limit: 1,
      forceIncludeTarget: { kind: "page", pageId: "page:25" },
    });
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
        {...baseProps}
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
        {...baseProps}
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

  test("reports each Show more step and Show less to the depth owner", async () => {
    const onExtraPagesChange = vi.fn();
    renderWithMaitai(
      <DepthOwner
        {...baseProps}
        activeRoot={null}
        dataSource={dataSource(pages(18))}
        onExtraPagesChange={onExtraPagesChange}
      />,
    );

    expect(contentRowTitles()).toHaveLength(5);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      await Promise.resolve();
    });
    expect(contentRowTitles()).toHaveLength(15);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      await Promise.resolve();
    });
    expect(contentRowTitles()).toHaveLength(18);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      await Promise.resolve();
    });
    expect(contentRowTitles()).toHaveLength(5);
    expect(onExtraPagesChange.mock.calls).toEqual([[1], [2], [0]]);
  });

  test("opens a Page's shared resource menu from the whole row context target", async () => {
    const onOpenRoot = vi.fn();
    const onHoverSurfaceOpenChange = vi.fn();
    renderWithMaitai(
      <SidebarPagesSection
        {...baseProps}
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
        {...baseProps}
        activeRoot={null}
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
      ...baseProps,
      activeRoot: null,
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

  test("restores a remembered depth by reading windows until it is filled", async () => {
    const onRead = vi.fn();
    renderWithMaitai(
      <DepthOwner
        {...baseProps}
        activeRoot={null}
        initialExtraPages={2}
        dataSource={windowedDataSource(60, onRead)}
      />,
    );

    await waitFor(() => expect(contentRowTitles()).toHaveLength(25));
    expect(contentRowTitles().at(-1)).toBe("Page 25");
    // One row beyond the depth is loaded, so no further window is read until Show more.
    expect(onRead.mock.calls).toEqual([[2]]);
    expect(screen.getByRole("button", { name: "Show more" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Show less" })).not.toBeNull();
  });

  test("opening a listed root changes neither the rows nor their order", async () => {
    const source = windowedDataSource(30);
    const view = renderWithMaitai(
      <DepthOwner {...baseProps} activeRoot={null} initialExtraPages={1} dataSource={source} />,
    );
    const before = contentRowTitles();
    view.rerender(
      <DepthOwner
        {...baseProps}
        activeRoot={{ kind: "page", pageId: "page:12" }}
        initialExtraPages={1}
        dataSource={source}
      />,
    );

    expect(contentRowTitles()).toEqual(before);
    expect(
      screen.getByText("Page 12").closest("[aria-current]")?.getAttribute("aria-current"),
    ).toBe("page");
  });

  test("a selected root beyond the loaded rows joins after them, then takes its own position", async () => {
    renderWithMaitai(
      <DepthOwner
        {...baseProps}
        activeRoot={{ kind: "page", pageId: "page:27" }}
        dataSource={windowedDataSource(40)}
      />,
    );

    expect(contentRowTitles()).toEqual([
      "Page 1",
      "Page 2",
      "Page 3",
      "Page 4",
      "Page 5",
      "Page 27",
    ]);
    for (let step = 0; step < 2; step += 1) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Show more" }));
        await Promise.resolve();
      });
    }

    await waitFor(() => expect(contentRowTitles()).toHaveLength(26));
    const titles = contentRowTitles();
    expect(titles.slice(0, 25)).toEqual(pages(25).map((page) => page.title));
    expect(titles.at(-1)).toBe("Page 27");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(contentRowTitles()).toHaveLength(35));
    expect(contentRowTitles()).toEqual(pages(35).map((page) => page.title));
  });

  test("omits a selected resource that Content does not list", () => {
    const source = windowedDataSource(30);
    renderWithMaitai(
      <SidebarPagesSection
        {...baseProps}
        activeRoot={{ kind: "database", databaseId: parseDatabaseId("database:inbox") }}
        dataSource={source}
      />,
    );

    expect(contentRowTitles()).toEqual(pages(5).map((page) => page.title));
    expect(screen.queryByRole("listitem", { current: "page" })).toBeNull();
  });

  test("projects a mounted Page's live title without changing its resource identity", async () => {
    const store = createPageTitleProjectionStore();
    const onOpenRoot = vi.fn();
    renderWithMaitai(
      <PageTitleProjectionProvider currentLibraryId="library-a" store={store}>
        <SidebarPagesSection
          {...baseProps}
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
