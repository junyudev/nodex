import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { LibraryCatalogEntry, LibraryRouteTarget } from "../../../shared/library-module";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { SpaceContentDataSource } from "./space-content";
import { SpaceHome } from "./space-home";

const entry = (
  target: LibraryCatalogEntry["target"],
  title: string,
  locationLabel: string,
): LibraryCatalogEntry => ({
  target,
  title,
  kind: target.kind,
  lifecycle: "active",
  locationLabel,
  updatedAt: "2026-08-04T00:00:00.000Z",
  locationRevision: 1,
  metadataRevision: 1,
});

const roadmap = entry({ kind: "page", pageId: "page:roadmap" }, "Roadmap", "Library");
const tasks = entry({ kind: "database", databaseId: "db:tasks" as never }, "Tasks", "Library");

function createDataSource(entries: readonly LibraryCatalogEntry[]) {
  const catalogInputs: { kinds?: readonly string[]; query?: string }[] = [];
  const createdPage: LibraryRouteTarget = { kind: "page", pageId: "page:new" };
  const dataSource = {
    useCatalog: (input) => {
      const request = (input ?? {}) as { kinds?: readonly string[]; query?: string };
      catalogInputs.push({ kinds: request.kinds, query: request.query });
      const items = entries.filter(
        (item) =>
          (!request.kinds || request.kinds.includes(item.kind)) &&
          (!request.query || item.title.toLowerCase().includes(request.query.toLowerCase())),
      );
      return {
        data: {
          pages: [
            {
              kind: "catalog" as const,
              libraryId: "library:test",
              storeEpoch: "epoch:test",
              commitSeq: 1,
              items,
              nextCursor: null,
              hasMore: false,
              total: items.length,
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
      };
    },
    useCreateCommands: (input) => ({
      isPending: false,
      createPage: async () => {
        input?.onCreated?.(createdPage);
        return createdPage;
      },
      createDatabase: async () => undefined,
    }),
  } satisfies SpaceContentDataSource;
  return { dataSource, catalogInputs, createdPage };
}

function renderHome(entries: readonly LibraryCatalogEntry[]) {
  const onOpenTarget = vi.fn();
  const fixture = createDataSource(entries);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NodexTooltipProvider>
        <SpaceHome dataSource={fixture.dataSource} onOpenTarget={onOpenTarget} />
      </NodexTooltipProvider>
    </QueryClientProvider>,
  );
  return { ...fixture, onOpenTarget };
}

describe("SpaceHome", () => {
  test("lists Space content by last edit and opens a row", async () => {
    const { onOpenTarget } = renderHome([roadmap, tasks]);

    expect(screen.getByRole("heading", { level: 1, name: "Space" })).toBeDefined();
    const list = screen.getByRole("list", { name: "Recent" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Roadmap"), expect.stringContaining("Tasks")]);
    await act(async () => {
      fireEvent.click(within(list).getByRole("button", { name: /Tasks/ }));
      await Promise.resolve();
    });
    expect(onOpenTarget).toHaveBeenCalledWith(tasks.target, "Tasks");
  });

  test("filters by kind and says when a kind has nothing yet", async () => {
    const { catalogInputs } = renderHome([roadmap]);

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "Databases" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(catalogInputs.at(-1)?.kinds).toEqual(["database"]);
    expect(screen.getByRole("status").textContent).toContain("No databases yet");
    expect(screen.queryByRole("button", { name: /Roadmap/ })).toBeNull();
  });

  test("searches in place and Escape clears the query", async () => {
    renderHome([roadmap, tasks]);
    const search = screen.getByRole("textbox", { name: "Search Space" });

    await act(async () => {
      fireEvent.change(search, { target: { value: "zzz" } });
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toContain("No results for “zzz”");

    await act(async () => {
      fireEvent.keyDown(search, { key: "Escape" });
      await Promise.resolve();
    });
    expect((search as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("list", { name: "Recent" })).toBeDefined();
  });

  test("New creates a Page and opens it", async () => {
    const { onOpenTarget, createdPage } = renderHome([]);

    expect(screen.getByRole("status").textContent).toContain("Nothing in Space yet");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New" }));
      await Promise.resolve();
    });
    const newPage = await screen.findByRole("menuitem", { name: "Page" });
    await act(async () => {
      fireEvent.click(newPage);
      await Promise.resolve();
    });
    expect(onOpenTarget).toHaveBeenCalledWith(createdPage);
  });
});
