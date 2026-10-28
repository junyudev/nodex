import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { LibraryCatalogEntry } from "../../../shared/library-module";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { resolveNewTabToolLayout } from "@/lib/workbench-new-tab-model";
import { getPanelNewTabAction, type PanelNewTabActionKind } from "@/lib/workbench-panel-actions";
import { openNodexMenu } from "../../test/dom";
import type { SpaceContentDataSource } from "./space-content";
import { WorkbenchNewTabPage, type WorkbenchNewTabPageProps } from "./workbench-new-tab-page";

const recent = (pageId: string, title: string, updatedAt: string): LibraryCatalogEntry => ({
  target: { kind: "page", pageId },
  title,
  kind: "page",
  lifecycle: "active",
  locationLabel: "Library",
  updatedAt,
  locationRevision: 1,
  metadataRevision: 1,
});

function recentsDataSource(entries: readonly LibraryCatalogEntry[]): SpaceContentDataSource {
  return {
    useCatalog: () => ({
      data: {
        pages: [
          {
            kind: "catalog" as const,
            libraryId: "library:test",
            storeEpoch: "epoch:test",
            commitSeq: 1,
            items: [...entries],
            nextCursor: null,
            hasMore: false,
            total: entries.length,
          },
        ],
        pageParams: [undefined],
      },
      isPending: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      refetch: async () => ({}) as never,
      fetchNextPage: async () => ({}) as never,
    }),
    useCreateCommands: () => ({
      isPending: false,
      createPage: async () => null,
      createDatabase: async () => undefined,
    }),
  };
}

function renderPage(
  kinds: readonly PanelNewTabActionKind[],
  overrides: Partial<WorkbenchNewTabPageProps> = {},
) {
  const onSelectAction = vi.fn();
  const onOpenRecent = vi.fn();
  const layout = resolveNewTabToolLayout(kinds.map(getPanelNewTabAction), {
    hasShortcut: (action) => action.shortcut !== undefined,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NodexTooltipProvider>
        <WorkbenchNewTabPage
          layout={layout}
          isMac
          projects={[]}
          currentProjectId="alpha"
          onSelectAction={onSelectAction}
          onOpenDestination={() => undefined}
          bottomTerminal={null}
          onOpenRecent={onOpenRecent}
          recentsDataSource={recentsDataSource([
            recent("page:draft", "Weekend draft", "2026-10-27T09:05:00"),
            recent("page:plan", "Launch plan", "2026-10-20T09:05:00"),
          ])}
          {...overrides}
        />
      </NodexTooltipProvider>
    </QueryClientProvider>,
  );
  return { onSelectAction, onOpenRecent };
}

describe("WorkbenchNewTabPage", () => {
  test("shows every tool as a tile, with the Page picker on Open page", async () => {
    const { onSelectAction } = renderPage([
      "terminal",
      "browser",
      "files",
      "new_page",
      "db_view",
      "page_stage",
      "canvas_stage",
    ]);
    const tools = screen.getByRole("heading", { name: "Tools" }).parentElement;
    if (!tools) throw new Error("Expected the Tools section");

    expect(within(tools).queryByRole("button", { name: /^Browser/ })).toBe(null);
    expect(within(tools).queryByRole("button", { name: /More tools/ })).toBe(null);
    await act(async () => {
      fireEvent.click(within(tools).getByRole("button", { name: /New page/ }));
      fireEvent.click(within(tools).getByRole("button", { name: /Canvas/ }));
      await Promise.resolve();
    });
    expect(onSelectAction.mock.calls).toEqual([["new_page"], ["canvas_stage"]]);

    // Open page offers the Page picker instead of running directly.
    expect(
      within(tools)
        .getByRole("button", { name: /Open page/ })
        .closest("[aria-haspopup]"),
    ).not.toBe(null);
    expect(onSelectAction).not.toHaveBeenCalledWith("page_stage");
  });

  test("opens a recent page from its row", async () => {
    const { onOpenRecent } = renderPage(["terminal", "new_page"]);
    const recents = screen.getByRole("list", { name: "Recent pages" });

    expect(within(recents).getAllByRole("listitem")).toHaveLength(2);
    await act(async () => {
      fireEvent.click(within(recents).getByRole("button", { name: "Launch plan" }));
      await Promise.resolve();
    });
    expect(onOpenRecent).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "page", pageId: "page:plan" } }),
    );
  });

  test("offers the bottom terminal from the Terminal tile", async () => {
    const onOpen = vi.fn();
    renderPage(["terminal", "files"], { bottomTerminal: { shortcut: "⌘J", onOpen } });

    await openNodexMenu(screen.getByRole("button", { name: "Terminal options" }));
    const menu = await screen.findByRole("menu");
    await act(async () => {
      fireEvent.click(within(menu).getByText("Open bottom terminal"));
      await Promise.resolve();
    });
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
