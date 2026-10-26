import type { ComponentProps } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { renderWithMaitai } from "@/test/thread-maitai";
import type { SidebarReorderDndProvider } from "./sidebar-reorder-dnd";
import { WorkbenchSpaceSidebarContent } from "./workbench-space-sidebar-content";

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn(async (_operation: unknown) => undefined) }));

vi.mock("@/lib/use-library-navigation", () => ({
  useApplyLibraryOperation: () => ({ mutation: { mutateAsync: mocks.mutateAsync } }),
}));
vi.mock("./sidebar-pages-section", () => ({ SidebarPagesSection: () => null }));
vi.mock("./sidebar-reorder-dnd", () => ({
  SidebarReorderDndProvider: ({
    children,
    onLibraryMove,
  }: ComponentProps<typeof SidebarReorderDndProvider>) => (
    <>
      {children}
      <button
        onClick={() =>
          void onLibraryMove?.({
            resource: {
              kind: "sidebar-library-resource",
              target: { kind: "page", pageId: "page-a" },
              title: "Page A",
              expectedLocationRevision: 7,
              dragOverlay: null,
            },
            parent: { kind: "library", before: { blockId: "page-b", expectedLocationRevision: 4 } },
          })
        }
      >
        Move Page
      </button>
    </>
  ),
}));

describe("WorkbenchSpaceSidebarContent", () => {
  test("commits library drag placement through the shared resource move boundary", async () => {
    renderWithMaitai(
      <WorkbenchSpaceSidebarContent
        collapsed={false}
        extraPages={0}
        onExtraPagesChange={vi.fn()}
        activeRoot={null}
        onToggle={vi.fn()}
        onOpenRoot={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move Page" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith({
        kind: "move_block",
        target: { kind: "page", pageId: "page-a", expectedLocationRevision: 7 },
        parent: { kind: "library", before: { blockId: "page-b", expectedLocationRevision: 4 } },
      }),
    );
  });
});
