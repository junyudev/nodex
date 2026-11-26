import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  __getNodexToastSnapshotForTests,
  __resetNodexToastStoreForTests,
} from "@/components/ui/toast";
import { render } from "@/test/dom";
import { PageMoveDestinationPicker } from "./page-move-destination-picker";

const navigation = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  relocationRead: vi.fn(),
  undoPageRelocation: vi.fn(),
  searchPending: false,
}));

const databaseDestination = {
  key: "database:beta",
  kind: "database" as const,
  title: "Beta",
  path: ["Project Beta"],
  hasChildren: false,
  isCurrent: false,
  updatedAt: "2026-08-30T00:00:00.000Z",
  destination: {
    kind: "data_source" as const,
    dataSourceId: "datasource:beta",
    viewId: "view:beta",
    at: { kind: "end" as const },
  },
  expectedMoveEtag: "etag:beta",
};

const currentDestination = {
  key: "library:library-1",
  kind: "library" as const,
  title: "Pages",
  path: [],
  hasChildren: true,
  isCurrent: true,
  updatedAt: "2026-08-30T00:00:00.000Z",
  destination: { kind: "library" as const, at: { kind: "end" as const } },
  expectedMoveEtag: "etag:pages",
};

const recentDestination = {
  ...currentDestination,
  key: "page:recent",
  kind: "page" as const,
  title: "Recent destination",
  isCurrent: false,
  destination: { kind: "page" as const, pageId: "page:recent", at: { kind: "end" as const } },
};

vi.mock("@/lib/use-library-navigation", () => ({
  useApplyLibraryOperation: () => ({ mutation: { mutateAsync: navigation.mutateAsync } }),
  useUndoLibraryPageRelocation: () => navigation.undoPageRelocation,
  useLibraryPageRelocationDestinations: (
    _pageId: string,
    input: { readonly scope: { readonly kind: string; readonly query?: string } },
  ) => {
    navigation.relocationRead(input.scope);
    const isFetching = navigation.searchPending && input.scope.kind === "page_candidates";
    return {
      data: {
        items:
          input.scope.kind === "databases" && !input.scope.query
            ? [databaseDestination]
            : input.scope.kind === "page_children"
              ? [currentDestination]
              : input.scope.kind === "page_suggested"
                ? [recentDestination]
                : [],
        hasMore: false,
      },
      isLoading: isFetching,
      isFetching,
      error: null,
      refetch: vi.fn(),
    };
  },
  useLibraryPageRelocationChildren: () => [],
}));

vi.mock("@/lib/interactive-page-search", () => ({
  configuredPageSearchProjectIds: () => [],
  useInteractivePageSearch: (input: { readonly query: string }) => ({
    rows:
      input.query === "Roadmap" || input.query === "Interview"
        ? [
            {
              pageId: "page:preview",
              title: input.query === "Interview" ? "Interview notes" : "Preview Roadmap",
              locationLabel: "Pages / Planning",
              updatedAt: "2026-08-30T00:00:00.000Z",
            },
          ]
        : [],
    initialPending: false,
    enrichment: input.query === "Interview" ? "loading" : "settled",
    queryRevision: input.query,
  }),
}));

describe("PageMoveDestinationPicker", () => {
  beforeEach(() => {
    __resetNodexToastStoreForTests();
    navigation.mutateAsync.mockReset().mockImplementation(async (operation) =>
      operation.kind === "move_page"
        ? {
            pageRelocation: {
              undoToken: {
                transferOperationId: "transfer:one",
                recipeHash: "recipe:one",
                storeEpoch: "epoch:one",
              },
            },
          }
        : {},
    );
    navigation.relocationRead.mockClear();
    navigation.undoPageRelocation.mockReset().mockResolvedValue({});
    navigation.searchPending = false;
  });

  test("moves immediately to an authoritative destination and offers typed Undo", async () => {
    const onClose = vi.fn();
    render(<PageMoveDestinationPicker pageId="page:one" title="Release plan" onClose={onClose} />);

    expect(screen.getByText("Project Beta")).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /SpaceCurrent/u }).getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /BetaProject Beta/u }));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(navigation.mutateAsync).toHaveBeenCalledWith({
        kind: "move_page",
        pageId: "page:one",
        destination: databaseDestination.destination,
        expectedEtag: "etag:beta",
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    const movedToast = __getNodexToastSnapshotForTests().find(
      (item) => item.title === "Moved to Beta",
    );
    expect(movedToast?.action?.label).toBe("Undo");

    await act(async () => {
      movedToast?.action?.onClick();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(navigation.undoPageRelocation).toHaveBeenCalledWith({
        transferOperationId: "transfer:one",
        recipeHash: "recipe:one",
        storeEpoch: "epoch:one",
      }),
    );
  });

  test("searches Database and Page authority together", async () => {
    render(
      <PageMoveDestinationPicker
        pageId="page:one"
        title="Release plan"
        onClose={() => undefined}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Move Release plan to" }), {
      target: { value: "Roadmap" },
    });

    await waitFor(() => {
      expect(navigation.relocationRead).toHaveBeenCalledWith({
        kind: "databases",
        query: "roadmap",
      });
      expect(navigation.relocationRead).toHaveBeenCalledWith({
        kind: "page_candidates",
        pageIds: ["page:preview"],
      });
    });
  });

  test("shows the empty status when search has no eligible destinations", async () => {
    render(
      <PageMoveDestinationPicker
        pageId="page:one"
        title="Release plan"
        onClose={() => undefined}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Move Release plan to" });
    const results = within(screen.getByRole("listbox"));
    await results.findByRole("option", { name: "Recent destination" });

    for (const query of ["zzqqxx", "Interview"]) {
      await act(async () => {
        fireEvent.change(input, { target: { value: query } });
      });

      await results.findByText("No matching destinations");
      expect(results.queryByRole("option")).toBeNull();
      expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("false");

      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      expect(navigation.mutateAsync).not.toHaveBeenCalled();
    }
  });

  test("keeps query-fresh metadata previews inert until relocation authority arrives", async () => {
    navigation.searchPending = true;
    render(
      <PageMoveDestinationPicker
        pageId="page:one"
        title="Release plan"
        onClose={() => undefined}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Move Release plan to" }), {
      target: { value: "Roadmap" },
    });
    const preview = await screen.findByRole("option", { name: /Preview Roadmap/u });
    expect(preview.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(preview);
    expect(navigation.mutateAsync).not.toHaveBeenCalled();
  });
});
