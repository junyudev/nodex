import { act, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { SidebarPaginatedItems, type SidebarPaginatedSource } from "./sidebar-paginated-items";

const WINDOW_ROWS = 10;

/** A list read from a source in windows, revealed to a remembered depth. */
function WindowedList({
  total,
  extraPages,
  failed = false,
  onRead,
}: {
  readonly total: number;
  readonly extraPages: number;
  readonly failed?: boolean;
  readonly onRead: () => void;
}) {
  const [loaded, setLoaded] = useState(WINDOW_ROWS);
  const items = Array.from({ length: Math.min(loaded, total) }, (_, index) => `row-${index + 1}`);
  const source: SidebarPaginatedSource = {
    hasMore: loaded < total,
    failed,
    loadMore: async () => {
      onRead();
      if (!failed) setLoaded((current) => current + WINDOW_ROWS);
    },
  };
  return (
    <SidebarPaginatedItems
      items={items}
      getKey={(item) => item}
      maxItems={5}
      extraPages={extraPages}
      onExtraPagesChange={() => {}}
      source={source}
    >
      {(pagination, pager) => (
        <div role="list" aria-label="Rows">
          {pagination.visibleItems.map((item) => (
            <div role="listitem" key={item}>
              {item}
            </div>
          ))}
          {pager}
        </div>
      )}
    </SidebarPaginatedItems>
  );
}

const visibleRows = () => screen.queryAllByText(/^row-/u).map((row) => row.textContent);

describe("SidebarPaginatedItems source filling", () => {
  test("reads windows until a remembered depth has one row beyond it", async () => {
    const onRead = vi.fn();
    render(<WindowedList total={60} extraPages={2} onRead={onRead} />);

    await waitFor(() => expect(visibleRows()).toHaveLength(25));
    // 30 loaded rows cover depth 25 plus one, so no further window is read.
    expect(onRead).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Show more" })).not.toBeNull();
  });

  test("does not read again while the source reports a failure", async () => {
    const onRead = vi.fn();
    render(<WindowedList total={60} extraPages={2} failed onRead={onRead} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(onRead).not.toHaveBeenCalled();
    expect(visibleRows()).toHaveLength(10);
  });

  test("leaves the source alone when the first page is already covered", async () => {
    const onRead = vi.fn();
    render(<WindowedList total={60} extraPages={0} onRead={onRead} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(onRead).not.toHaveBeenCalled();
    expect(visibleRows()).toHaveLength(5);
  });
});
