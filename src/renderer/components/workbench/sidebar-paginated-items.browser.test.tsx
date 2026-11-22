import { act } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { SidebarPaginatedItems, SidebarPaginatedRows } from "./sidebar-paginated-items";
import "../../globals.css";

const ROW_HEIGHT = 30;

function PagedRows({
  total,
  initialExtraPages = 0,
}: {
  readonly total: number;
  readonly initialExtraPages?: number;
}) {
  const [extraPages, setExtraPages] = useState(initialExtraPages);
  const rows = Array.from({ length: total }, (_, index) => `Row ${index + 1}`);
  return (
    <SidebarPaginatedItems
      items={rows}
      getKey={(row) => row}
      maxItems={5}
      extraPages={extraPages}
      onExtraPagesChange={setExtraPages}
    >
      {(pagination, pager) => (
        <div role="list" aria-label="Rows">
          <SidebarPaginatedRows>
            {pagination.visibleItems.map((row) => (
              <div key={row} role="listitem" style={{ height: ROW_HEIGHT }}>
                {row}
              </div>
            ))}
          </SidebarPaginatedRows>
          {pager}
        </div>
      )}
    </SidebarPaginatedItems>
  );
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

interface Sample {
  readonly height: number;
  readonly rows: number;
  /** Distance from the rows' clipped edge to the top of the pager. */
  readonly pagerGap: number;
  readonly pagerTop: number;
}

/** Presses a pager button, then samples each frame until the rows let go of their height. */
async function press(name: "Show more" | "Show less", view: ReturnType<typeof render>) {
  const clip = view.container.querySelector<HTMLElement>("[data-sidebar-paginated-rows]");
  if (!clip) throw new Error("Expected paginated rows");
  const button = view.getByRole("button", { name });
  const pager = button.parentElement;
  if (!pager) throw new Error("Expected a pager row");
  const pressedAt = pager.getBoundingClientRect().top;
  await act(async () => {
    await userEvent.click(button);
  });
  const samples: Sample[] = [];
  for (let frame = 0; frame < 120 && clip.style.height !== ""; frame += 1) {
    const edge = clip.getBoundingClientRect();
    samples.push({
      height: edge.height,
      rows: view.queryAllByText(/^Row /u).length,
      pagerGap: pager.getBoundingClientRect().top - edge.bottom,
      pagerTop: pager.getBoundingClientRect().top,
    });
    await act(async () => {
      await nextFrame();
    });
  }
  return {
    clip,
    samples,
    pressedAt,
    pagerTop: () => pager.getBoundingClientRect().top,
    height: () => clip.getBoundingClientRect().height,
  };
}

const moves = (samples: readonly Sample[], direction: 1 | -1) =>
  samples.every(
    (sample, index) =>
      index === 0 || (sample.height - samples[index - 1]!.height) * direction >= -0.5,
  );

test("pager presses ease the rows' edge and the pager rides it", async () => {
  const view = render(<PagedRows total={16} />);
  const rowsBox = view.container.querySelector<HTMLElement>("[data-sidebar-paginated-rows]")!;
  const firstPage = rowsBox.getBoundingClientRect().height;

  const more = await press("Show more", view);
  const revealed = more.height();
  expect(revealed - firstPage).toBeCloseTo(5 * ROW_HEIGHT, 0);
  // Every revealed row is mounted from the first frame; the edge unfolds over them.
  expect(more.samples.every((sample) => sample.rows === 10)).toBe(true);
  expect(more.samples.some((s) => s.height > firstPage + 1 && s.height < revealed - 1)).toBe(true);
  expect(moves(more.samples, 1)).toBe(true);
  // The pager never leaves the edge, so it stays on screen throughout.
  expect(more.samples.every((sample) => Math.abs(sample.pagerGap) < 0.5)).toBe(true);
  expect(more.clip.style.overflow).toBe("");

  const allRows = (await press("Show more", view)).height();
  const less = await press("Show less", view);
  // One press folds every revealed row back to the first page. The hidden rows stay while
  // the edge folds up past them, then leave.
  const folding = less.samples.filter((s) => s.height > firstPage + 1 && s.height < allRows - 1);
  expect(folding.length).toBeGreaterThan(0);
  expect(folding.every((sample) => sample.rows === 16)).toBe(true);
  expect(moves(less.samples, -1)).toBe(true);
  expect(less.samples.every((sample) => Math.abs(sample.pagerGap) < 0.5)).toBe(true);
  expect(view.getAllByText(/^Row /u)).toHaveLength(5);
  expect(less.height()).toBeCloseTo(firstPage, 0);
  expect(less.clip.style.overflow).toBe("");
});

test("Show less keeps the pager where it was pressed when the rows' top has scrolled away", async () => {
  const view = render(
    <div data-testid="sidebar" style={{ height: 300, overflowY: "auto" }}>
      <div style={{ height: 200 }} />
      <PagedRows total={30} initialExtraPages={4} />
      <div style={{ height: 1000 }} />
    </div>,
  );
  const sidebar = view.getByTestId("sidebar");
  const pager = view.getByRole("button", { name: "Show less" }).parentElement!;
  // Scroll the first 25 rows' top out of view, leaving the pager 200px down the sidebar.
  sidebar.scrollTop = pager.getBoundingClientRect().top - sidebar.getBoundingClientRect().top - 200;
  const scrolledTo = sidebar.scrollTop;
  await act(async () => {
    await nextFrame();
  });

  const less = await press("Show less", view);
  // The sidebar scrolls back with the fold, so the pager never leaves the pressed spot.
  expect(less.samples.some((sample) => sample.rows === 25)).toBe(true);
  expect(less.samples.every((sample) => Math.abs(sample.pagerTop - less.pressedAt) < 1)).toBe(true);
  expect(view.getAllByText(/^Row /u)).toHaveLength(5);
  expect(less.pagerTop()).toBeCloseTo(less.pressedAt, 0);
  expect(scrolledTo - sidebar.scrollTop).toBeCloseTo(20 * ROW_HEIGHT, 0);
});
