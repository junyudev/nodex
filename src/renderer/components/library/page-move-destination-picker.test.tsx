import { act, fireEvent, screen, waitFor } from "@testing-library/react";
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

vi.mock("@/lib/use-library-navigation", () => ({
  useApplyLibraryOperation: () => ({ mutation: { mutateAsync: navigation.mutateAsync } }),
  useUndoLibraryPageRelocation: () => navigation.undoPageRelocation,
  useLibraryPageRelocationDestinations: (
    _pageId: string,
    input: { readonly scope: { readonly kind: string } },
  ) => {
    navigation.relocationRead(input.scope);
    return {
      data: {
        items:
          input.scope.kind === "databases"
            ? [databaseDestination]
            : input.scope.kind === "page_children"
              ? [currentDestination]
              : [],
        hasMore: false,
      },
      isPending: navigation.searchPending && input.scope.kind === "page_search",
      error: null,
      refetch: vi.fn(),
    };
  },
  useLibraryPageRelocationChildren: () => [],
}));

vi.mock("@/lib/interactive-page-search", () => ({
  configuredPageSearchProjectIds: () => [],
  useInteractivePageSearch: (input: { readonly query: string }) => ({
    rows: input.query
      ? [
          {
            pageId: "page:preview",
            title: "Preview Roadmap",
            locationLabel: "Pages / Planning",
            updatedAt: "2026-08-30T00:00:00.000Z",
          },
        ]
      : [],
    enrichment: "idle",
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
      screen.getByRole("option", { name: /PagesCurrent/u }).getAttribute("aria-disabled"),
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
      (item) => item.kind === "plain" && item.title === "Moved to Beta",
    );
    expect(movedToast?.kind === "plain" ? movedToast.action?.label : null).toBe("Undo");

    await act(async () => {
      if (movedToast?.kind === "plain") movedToast.action?.onClick();
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
        kind: "page_search",
        query: "roadmap",
      });
    });
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
