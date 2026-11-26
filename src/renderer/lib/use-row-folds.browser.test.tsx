import { useRef } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { useRowFolds } from "./use-row-folds";

const FOLDS = ["fold-tools", "fold-views"] as const;

// Views are 300px wide, 120px folded; tools are 150px, 60px folded.
const ROW_CSS = `
  [data-row] { display: flex; }
  [data-region] { display: flex; flex: 1 1 0; min-width: 0; overflow-x: auto; }
  [data-views] { display: flex; flex: none; }
  [data-view] { flex: none; width: 100px; height: 24px; }
  [data-view].wide { width: 150px; }
  [data-row][data-fold-views] [data-view] { width: 40px; }
  [data-tools] { flex: none; width: 150px; height: 24px; }
  [data-row][data-fold-tools] [data-tools] { width: 60px; }
`;

function Row({
  width,
  views,
  wideFirst = false,
}: {
  readonly width: number;
  readonly views: number;
  /** Widens the first view by its class alone, as a view becoming current does. */
  readonly wideFirst?: boolean;
}) {
  const row = useRef<HTMLDivElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const folded = useRowFolds(row, region, FOLDS);
  return (
    <>
      <style>{ROW_CSS}</style>
      <output data-testid="folded">{folded}</output>
      <div ref={row} data-row data-testid="row" style={{ width }}>
        <div ref={region} data-region>
          <div data-views>
            {Array.from({ length: views }, (_, index) => (
              <span
                key={index}
                data-view
                className={index === 0 && wideFirst ? "wide" : undefined}
              />
            ))}
          </div>
        </div>
        <div data-tools />
      </div>
    </>
  );
}

describe("toolbar row folds", () => {
  test("folds in order only as far as the row needs, and unfolds when room returns", async () => {
    const view = render(<Row width={500} views={3} />);
    const row = view.getByTestId("row");
    const resize = async (width: number, views = 3, wideFirst = false) => {
      await act(async () => {
        view.rerender(<Row width={width} views={views} wideFirst={wideFirst} />);
        await Promise.resolve();
      });
    };
    const expectFolded = async (count: number) => {
      await waitFor(() => expect(view.getByTestId("folded").textContent).toBe(String(count)));
      expect(row.hasAttribute("data-fold-tools")).toBe(count >= 1);
      expect(row.hasAttribute("data-fold-views")).toBe(count >= 2);
    };

    // 300 + 150 fits 500.
    await expectFolded(0);
    // 300 + 150 overflows 400; 300 + 60 fits.
    await resize(400);
    await expectFolded(1);
    // 300 + 60 overflows 250; 120 + 60 fits.
    await resize(250);
    await expectFolded(2);
    // Nothing fits 150: the row stays fully folded and its region scrolls.
    await resize(150);
    await expectFolded(2);
    await resize(500);
    await expectFolded(0);

    // A fourth view needs more room without resizing the row: 400 + 60 overflows 400.
    await resize(400);
    await expectFolded(1);
    await resize(400, 4);
    await expectFolded(2);

    // A class alone widens the first view after a render of the row's owner: 350 + 60 overflows.
    await resize(400);
    await expectFolded(1);
    await resize(400, 3, true);
    await expectFolded(2);
  });
});
