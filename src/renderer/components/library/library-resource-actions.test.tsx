import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { NodexModalHost } from "@/lib/modal-registry";
import { renderWithMaitai } from "../../test/thread-maitai";

import { LibraryResourceActions } from "./library-resource-actions";

const navigation = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  refetchAccess: vi.fn(),
  undoPageRelocation: vi.fn(),
}));

const projectAccess = {
  kind: "resource_project_access" as const,
  value: {
    target: { kind: "page" as const, pageId: "page-1" },
    projects: [
      {
        projectId: "project-1",
        projectName: "Product",
        appearance: {
          color: "blue" as const,
          marker: { kind: "icon" as const, icon: "folder" as const },
        },
        lifecycle: "active" as const,
        directGrant: null,
        inheritedSources: [],
        effectiveAccess: null,
      },
    ],
  },
};

vi.mock("@/lib/use-library-navigation", () => ({
  useApplyLibraryOperation: () => ({
    mutation: {
      mutateAsync: navigation.mutateAsync,
      isPending: false,
    },
  }),
  useLibraryCatalog: () => ({ data: { items: [] } }),
  useLibraryPath: () => ({ data: undefined, isPending: false }),
  useLibraryMoveDestinations: () => ({
    data: {
      kind: "move_destinations",
      items: [],
      currentDestination: null,
      nextCursor: null,
      hasMore: false,
      total: 0,
      rootIsCurrent: false,
    },
    isPending: false,
    error: null,
  }),
  useLibraryMoveDestinationChildren: () => [],
  useUndoLibraryPageRelocation: () => navigation.undoPageRelocation,
  useLibraryPageRelocationDestinations: (
    _pageId: string,
    input: { readonly scope: { readonly kind: string } },
  ) => ({
    data: {
      items:
        input.scope.kind === "page_children"
          ? [
              {
                key: "library:library-1",
                kind: "library" as const,
                title: "Pages",
                path: [],
                hasChildren: true,
                isCurrent: false,
                updatedAt: "2026-08-30T00:00:00.000Z",
                destination: { kind: "library" as const, at: { kind: "end" as const } },
                expectedMoveEtag: "etag:pages",
              },
            ]
          : [],
      hasMore: false,
    },
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useLibraryPageRelocationChildren: () => [],
  useLibraryResourceProjectAccess: () => ({
    data: projectAccess,
    isPending: false,
    error: null,
    refetch: navigation.refetchAccess,
  }),
}));

vi.mock("@/lib/interactive-page-search", () => ({
  configuredPageSearchProjectIds: () => [],
  useInteractivePageSearch: () => ({ rows: [], enrichment: "idle", queryRevision: "" }),
}));

const openActions = async (): Promise<void> => {
  await act(async () => {
    fireEvent.mouseDown(
      screen.getByRole("button", {
        name: "Actions for Research",
      }),
      { button: 0, ctrlKey: false },
    );
    await Promise.resolve();
  });
};

const openMoveSubmenu = async () => {
  const moveItem = await screen.findByRole("menuitem", { name: "Move to" });
  await act(async () => {
    moveItem.focus();
    fireEvent.keyDown(moveItem, { key: "ArrowRight" });
    await Promise.resolve();
  });
  return await screen.findByRole("combobox", { name: "Move Research to" });
};

const renderActions = (
  props: Partial<ComponentProps<typeof LibraryResourceActions>> = {},
  onPageRowPointerDown = vi.fn(),
) =>
  renderWithMaitai(
    <NodexTooltipProvider>
      <div data-testid="page-row" onPointerDown={onPageRowPointerDown}>
        <LibraryResourceActions
          target={{ kind: "page", pageId: "page-1" }}
          title="Research"
          expectedLocationRevision={2}
          expectedMetadataRevision={3}
          projects={[{ id: "project-1", name: "Product" }]}
          onOpenInProject={() => undefined}
          {...props}
        />
      </div>
      <NodexModalHost />
    </NodexTooltipProvider>,
  );

describe("Library resource actions", () => {
  beforeEach(() => {
    navigation.mutateAsync.mockReset();
    navigation.undoPageRelocation.mockReset();
  });

  test("uses a plain label for the confirmation-only Archive action", async () => {
    const onPageRowPointerDown = vi.fn();
    renderActions({}, onPageRowPointerDown);

    await openActions();
    const archiveItem = await screen.findByRole("menuitem", { name: "Archive" });
    expect(screen.queryByRole("menuitem", { name: "Archive…" })).toBeNull();

    fireEvent.click(archiveItem);
    const dialog = await screen.findByRole("dialog");
    fireEvent.pointerDown(within(dialog).getByText("Archive this page?"));
    expect(onPageRowPointerDown).not.toHaveBeenCalled();
  });

  test("opens the all-Project access manager and preserves changes when cancelled", async () => {
    renderActions();

    await openActions();
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Manage access",
      }),
    );
    expect(await screen.findByRole("dialog")).not.toBeNull();
    expect(screen.getByText("Product")).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(navigation.mutateAsync).not.toHaveBeenCalled();
  });

  test("saves all edited Project access in one operation", async () => {
    navigation.mutateAsync.mockResolvedValue({ didMutate: true, pageRelocation: null });
    renderActions({ expectedMetadataRevision: undefined });

    await openActions();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage access" }));
    const accessButton = await screen.findByRole("button", { name: "Access for Product" });
    await act(async () => {
      fireEvent.mouseDown(accessButton, { button: 0, ctrlKey: false });
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Read & write" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(navigation.mutateAsync).toHaveBeenCalledWith({
        kind: "set_project_access",
        target: { kind: "page", pageId: "page-1" },
        changes: [
          {
            projectId: "project-1",
            access: "read_write",
            expectedRevision: null,
          },
        ],
      }),
    );
  });

  test("moves the resource from the menu-owned submenu", async () => {
    navigation.mutateAsync.mockResolvedValue({ didMutate: true });
    renderActions();

    await openActions();
    await openMoveSubmenu();
    const moveButton = await screen.findByRole("option", { name: /Pages\s*Top level/ });
    await act(async () => {
      fireEvent.click(moveButton);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(navigation.mutateAsync).toHaveBeenCalledWith({
        kind: "move_page",
        pageId: "page-1",
        destination: { kind: "library", at: { kind: "end" } },
        expectedEtag: "etag:pages",
      }),
    );
  });

  test("grants and opens the resource from the registry-owned modal", async () => {
    const onOpenInProject = vi.fn();
    navigation.mutateAsync.mockResolvedValue({ didMutate: true });
    renderActions({ onOpenInProject });

    await openActions();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Project…" }));
    const grantAndOpenButton = await screen.findByRole("button", { name: "Grant and open" });
    await act(async () => {
      fireEvent.click(grantAndOpenButton);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(navigation.mutateAsync).toHaveBeenCalledWith({
        kind: "grant_project_access",
        projectId: "project-1",
        target: { kind: "page", pageId: "page-1" },
        access: "read_write",
      }),
    );
    expect(onOpenInProject).toHaveBeenCalledWith(
      "project-1",
      { kind: "page", pageId: "page-1" },
      "Research",
    );
  });

  test.each([
    ["Manage access", "Manage access"],
    ["Open in Project…", "Open in Project"],
  ])("keeps the %s modal outside the draggable Page row", async (menuLabel, title) => {
    const onPageRowPointerDown = vi.fn();
    renderActions({}, onPageRowPointerDown);

    await openActions();
    fireEvent.click(await screen.findByRole("menuitem", { name: menuLabel }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.pointerDown(within(dialog).getByText(title));

    expect(onPageRowPointerDown).not.toHaveBeenCalled();
  });

  test("portals the Move to submenu outside the draggable Page row", async () => {
    const onPageRowPointerDown = vi.fn();
    renderActions({}, onPageRowPointerDown);

    await openActions();
    const searchInput = await openMoveSubmenu();
    const submenu = searchInput.closest("[data-slot='dropdown-submenu-content']");
    const pageRow = screen.getByTestId("page-row");
    expect(submenu).not.toBeNull();
    expect(pageRow.contains(submenu)).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Move Research" })).toBeNull();

    fireEvent.pointerDown(searchInput);
    expect(onPageRowPointerDown).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(searchInput, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("combobox", {
          name: "Move Research to",
        }),
      ).toBeNull(),
    );
    expect(screen.queryByRole("menuitem", { name: "Move to" })).toBeNull();
    expect(
      screen
        .getByRole("button", {
          name: "Actions for Research",
        })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("keeps Manage access mounted after its Page row unmounts", async () => {
    const view = renderActions();

    await openActions();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage access" }));
    expect(await screen.findByRole("dialog")).not.toBeNull();

    view.rerender(
      <NodexTooltipProvider>
        <NodexModalHost />
      </NodexTooltipProvider>,
    );

    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByText("Manage access")).not.toBeNull();
  });
});
