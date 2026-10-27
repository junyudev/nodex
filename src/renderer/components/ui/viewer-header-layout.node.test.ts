import { describe, expect, test } from "vite-plus/test";
import {
  planViewerHeaderCollapse,
  VIEWER_HEADER_SIDE_GAP,
  viewerHeaderRequiredWidth,
} from "./viewer-header-layout";

describe("viewer header layout", () => {
  test("collapses inner regions and whole slots in one priority order, unprioritized last", () => {
    const plan = planViewerHeaderCollapse([
      {
        id: "path",
        collapseSteps: [
          { priority: 1, selector: '[data-file-ancestor="1"]' },
          { priority: 0, selector: '[data-file-ancestor="0"]' },
        ],
      },
      { id: "actions", hidePriority: 2 },
      { id: "controls", collapsePriority: 0.5 },
    ]);
    expect(plan.map((step) => [step.slot.id, step.priority, step.selectors])).toEqual([
      ["path", 0, ['[data-file-ancestor="0"]']],
      ["controls", 0.5, ["[data-viewer-header-collapsible]"]],
      ["path", 1, ['[data-file-ancestor="1"]']],
      ["actions", 2, null],
      ["path", undefined, null],
      ["controls", undefined, null],
    ]);
  });

  test("counts gaps between visible slots and the side gap only when both sides show", () => {
    expect(
      viewerHeaderRequiredWidth({ width: 300, count: 3, gap: 6 }, { width: 0, count: 0, gap: 6 }),
    ).toBe(312);
    expect(
      viewerHeaderRequiredWidth({ width: 100, count: 1, gap: 6 }, { width: 50, count: 2, gap: 4 }),
    ).toBe(100 + 54 + VIEWER_HEADER_SIDE_GAP);
  });
});
