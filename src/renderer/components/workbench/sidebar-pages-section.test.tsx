import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { LibraryPageNavigationNode } from "../../../shared/library-module";
import { renderWithMaitai } from "@/test/dom";
import { SidebarPagesSection, type SidebarPagesDataSource } from "./sidebar-pages-section";

vi.mock("@/lib/use-library-navigation", () => ({
  useInfiniteLibraryStandaloneRoots: vi.fn(),
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

const dataSource = (items: readonly LibraryPageNavigationNode[]): SidebarPagesDataSource => ({
  useStandaloneRoots: () => ({
    data: {
      pages: [
        {
          kind: "standalone_roots",
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

describe("SidebarPagesSection", () => {
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

    const list = screen.getByRole("list", { name: "Pages" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.getByText("Page 2").closest("[data-active]")?.getAttribute("data-active")).toBe(
      "true",
    );
  });

  test("uses the shared Show more and Show less paging behavior", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Page 6")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Show less" })).not.toBeNull();
  });

  test("opens a Page's shared resource menu from the whole row context target", async () => {
    const onOpenRoot = vi.fn();
    renderWithMaitai(
      <SidebarPagesSection
        collapsed={false}
        activeRoot={null}
        onToggle={vi.fn()}
        onOpenRoot={onOpenRoot}
        dataSource={dataSource([makePage(1)])}
        mutationsEnabled
      />,
    );

    const row = screen.getByText("Page 1").closest<HTMLElement>("[role='listitem']");
    if (!row) throw new Error("Expected Sidebar Page row");
    fireEvent.contextMenu(row, { clientX: 120, clientY: 80 });

    expect(await screen.findByRole("menuitem", { name: "Move to" })).not.toBeNull();
    expect(onOpenRoot).not.toHaveBeenCalled();
  });
});
