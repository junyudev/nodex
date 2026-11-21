import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { LibraryCatalogEntry } from "../../../shared/library-module";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { NewTabShortcutPreference } from "@/lib/workbench-new-tab-model";
import { getPanelNewTabAction, type PanelNewTabActionKind } from "@/lib/workbench-panel-actions";
import { renderWithQuery } from "@/test/query";
import type { SpaceContentDataSource } from "./space-content";
import { WorkbenchNewTabPage, type WorkbenchNewTabPageProps } from "./workbench-new-tab-page";

const CHAT_SCENE_TOOLS = (
  [
    "side_chat",
    "review",
    "terminal",
    "new_page",
    "files",
    "page_stage",
    "db_view",
    "canvas_stage",
    "browser",
  ] satisfies PanelNewTabActionKind[]
).map(getPanelNewTabAction);
const DEFAULT_TILES = ["New page", "Side chat", "Terminal", "Files"];
const TOOL_NAMES = [...DEFAULT_TILES, "Review", "Open page…", "DB View", "Canvas"];
const MORE_OPTIONS = "More tools and shortcut options";

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

type PageProps = Omit<WorkbenchNewTabPageProps, "shortcuts">;

function PageWithShortcuts(props: PageProps) {
  const [preference, update] = useState<NewTabShortcutPreference | null>(null);
  return <WorkbenchNewTabPage {...props} shortcuts={{ preference, ready: true, update }} />;
}

function renderPage(overrides: Partial<PageProps> = {}) {
  const onSelectAction = vi.fn();
  const onOpenRecent = vi.fn();
  const view = renderWithQuery(
    <NodexTooltipProvider>
      <PageWithShortcuts
        tools={CHAT_SCENE_TOOLS}
        isMac
        projects={[]}
        currentProjectId={null}
        onSelectAction={onSelectAction}
        onOpenDestination={() => undefined}
        bottomTerminal={null}
        onOpenRecent={onOpenRecent}
        recentsDataSource={recentsDataSource([])}
        {...overrides}
      />
    </NodexTooltipProvider>,
  );
  return { ...view, onSelectAction, onOpenRecent };
}

async function click(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
}

async function pressEscape(target: Element) {
  await act(async () => {
    fireEvent.keyDown(target, { key: "Escape" });
    await Promise.resolve();
  });
}

async function openShortcuts() {
  await click(screen.getByRole("button", { name: MORE_OPTIONS }));
  return screen.findByRole("dialog", { name: "Shortcuts" });
}

function expectTiles(names: readonly string[]) {
  const open = within(screen.getByRole("region", { name: "Open" }));
  expect(open.getAllByRole("button")).toEqual(
    [MORE_OPTIONS, ...names].map((name) => open.getByRole("button", { name })),
  );
}

describe("WorkbenchNewTabPage", () => {
  test("shows search above the default Open tiles and runs a pinned tool", async () => {
    const { onSelectAction } = renderPage({ search: <input aria-label="Search pages" /> });
    const heading = screen.getByRole("heading", { name: "Open" });
    const search = screen.getByRole("textbox", { name: "Search pages" });
    expect(search.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expectTiles(DEFAULT_TILES);

    await click(screen.getByRole("button", { name: "New page" }));
    expect(onSelectAction).toHaveBeenCalledExactlyOnceWith("new_page");
  });

  test("pins and unpins tools without moving menu rows, then resets the tiles", async () => {
    renderPage();
    const menu = within(await openShortcuts());
    const expectToolOrder = () => {
      expect(menu.queryByRole("button", { name: "Browser" })).toBeNull();
      expect(menu.getAllByRole("button", { name: (name) => TOOL_NAMES.includes(name) })).toEqual(
        TOOL_NAMES.map((name) => menu.getByRole("button", { name })),
      );
    };
    expect(menu.queryByRole("button", { name: "Reset to default" })).toBeNull();
    expectToolOrder();

    await click(menu.getByRole("button", { name: "Pin Review" }));
    expectTiles([...DEFAULT_TILES, "Review"]);
    expectToolOrder();

    await click(menu.getByRole("button", { name: "Unpin Side chat" }));
    expectTiles(["New page", "Terminal", "Files", "Review"]);
    expectToolOrder();

    await click(menu.getByRole("button", { name: "Reset to default" }));
    expectTiles(DEFAULT_TILES);
  });

  test("runs a tool selected from Shortcuts and closes the menu", async () => {
    const { onSelectAction } = renderPage();
    const menu = within(await openShortcuts());

    await click(menu.getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(onSelectAction).toHaveBeenCalledExactlyOnceWith("terminal"));
    expect(screen.queryByRole("dialog", { name: "Shortcuts" })).toBeNull();
  });

  test("offers Open bottom terminal only when it is available", async () => {
    const unavailable = renderPage();
    const menu = within(await openShortcuts());
    expect(menu.queryByRole("button", { name: "Open bottom terminal" })).toBeNull();
    unavailable.unmount();

    const onOpen = vi.fn();
    renderPage({ bottomTerminal: { shortcut: "⌘J", onOpen } });
    const available = within(await openShortcuts());

    await click(available.getByRole("button", { name: "Open bottom terminal" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  test("opens the Page picker from both the pinned tile and the Shortcuts menu", async () => {
    const { onSelectAction } = renderPage();
    const menu = await openShortcuts();
    await click(within(menu).getByRole("button", { name: "Pin Open page…" }));
    await pressEscape(menu);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Shortcuts" })).toBeNull());

    await click(screen.getByRole("button", { name: "Open page…" }));
    const picker = await screen.findByRole("dialog", { name: "Open Page" });
    await pressEscape(within(picker).getByRole("combobox"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Open Page" })).toBeNull());

    const reopenedMenu = within(await openShortcuts());
    await click(reopenedMenu.getByRole("button", { name: "Open page…" }));
    expect(await screen.findByRole("dialog", { name: "Open Page" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Shortcuts" })).toBeNull();
    expect(onSelectAction).not.toHaveBeenCalled();
  });

  test("customizes pins and restores focus to More options on Escape", async () => {
    renderPage();
    const menu = within(await openShortcuts());
    await click(menu.getByRole("button", { name: "Customize" }));
    const heading = screen.getByRole("heading", { name: "Customize" });
    const customize = within(screen.getByRole("region", { name: "Customize" }));
    expect(customize.getByRole("heading")).toBe(heading);
    expect(customize.getAllByRole("checkbox")).toEqual(
      TOOL_NAMES.map((name) => customize.getByRole("checkbox", { name })),
    );
    expect(customize.getAllByRole("checkbox", { checked: true })).toEqual(
      DEFAULT_TILES.map((name) => customize.getByRole("checkbox", { name })),
    );

    await click(customize.getByRole("checkbox", { name: "DB View", checked: false }));
    expect(customize.getByRole("checkbox", { name: "DB View", checked: true })).toBeTruthy();
    await click(customize.getByRole("checkbox", { name: "Files", checked: true }));
    expect(customize.getByRole("checkbox", { name: "Files", checked: false })).toBeTruthy();
    await click(customize.getByRole("button", { name: "Done" }));
    expectTiles(["New page", "Side chat", "Terminal", "DB View"]);

    const reopenedMenu = within(await openShortcuts());
    await click(reopenedMenu.getByRole("button", { name: "Customize" }));
    await pressEscape(document.activeElement ?? document.body);
    expect(screen.getByRole("heading", { name: "Open" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: MORE_OPTIONS }));
  });

  test("opens a recent page from its row", async () => {
    const { onOpenRecent } = renderPage({
      recentsDataSource: recentsDataSource([
        recent("page:draft", "Weekend draft", "2026-10-27T09:05:00"),
        recent("page:plan", "Launch plan", "2026-10-20T09:05:00"),
      ]),
    });
    const recents = within(screen.getByRole("list", { name: "Recent pages" }));

    await click(recents.getByRole("button", { name: "Launch plan" }));
    expect(onOpenRecent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ target: { kind: "page", pageId: "page:plan" } }),
    );
  });
});
