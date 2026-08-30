import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { DatabaseMoveDestinationPickerSurface } from "./database-move-destination-picker";

const destination = {
  pageId: "page-product",
  title: "Product",
  path: ["Pages"],
  hasChildren: true,
  isCurrent: false,
  documentGeneration: 2,
  documentHeadSeq: 7,
  updatedAt: "2026-08-11T00:00:00.000Z",
} as const;

describe("DatabaseMoveDestinationPickerSurface", () => {
  test("skips the current location and immediately accepts the focused destination", async () => {
    const onAccept = vi.fn();
    const onToggle = vi.fn();
    render(
      <DatabaseMoveDestinationPickerSurface
        ariaLabel="Move Roadmap to"
        query=""
        sections={[
          {
            key: "pages",
            label: "Pages",
            rows: [
              {
                kind: "root",
                id: "library-root",
                label: "Pages",
                metadata: "Current",
                disabled: true,
              },
              {
                kind: "page",
                id: "tree:page-product",
                entry: destination,
                depth: 0,
                expanded: false,
                context: "tree",
              },
            ],
          },
        ]}
        loading={false}
        stale={false}
        error={null}
        acceptingRowId={null}
        hasMore={false}
        onQueryChange={vi.fn()}
        onToggle={onToggle}
        onAccept={onAccept}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Move Roadmap to" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowRight" });
      await Promise.resolve();
    });
    expect(onToggle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tree:page-product",
      }),
    );

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tree:page-product",
      }),
    );
    expect(
      screen.getByRole("option", { name: /Pages\s*Current/ }).getAttribute("aria-disabled"),
    ).toBe("true");
  });
});
