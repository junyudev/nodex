import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StageRail, type StageRailStage } from "./stage-rail";

function SquareIcon({ className }: { className?: string }) {
  return createElement("span", { className }, "I");
}

const STAGES: StageRailStage[] = [
  {
    id: "db",
    title: "Views",
    icon: SquareIcon,
    content: createElement("div", undefined, "views"),
  },
  {
    id: "cards",
    title: "Cards",
    icon: SquareIcon,
    content: createElement("div", undefined, "cards"),
  },
  {
    id: "threads",
    title: "Threads",
    icon: SquareIcon,
    content: createElement("div", undefined, "threads"),
  },
  {
    id: "files",
    title: "Diffs",
    icon: SquareIcon,
    content: createElement("div", undefined, "diff"),
  },
];

describe("StageRail", () => {
  test("renders collapsed stages as icon buttons", () => {
    const markup = renderToStaticMarkup(
      createElement(StageRail, {
        stages: STAGES,
        focusedStage: "cards",
        collapsedStages: {
          cards: true,
          threads: true,
        },
        onFocusStage: () => undefined,
        onSetStageCollapsed: () => undefined,
      }),
    );

    expect(markup.includes("Expand Cards")).toBeTrue();
    expect(markup.includes("Expand Threads")).toBeTrue();
    expect(markup.match(/data-stage-collapsed=\"true\"/g)?.length ?? 0).toBe(2);
  });

  test("stacks adjacent collapsed stages vertically in one rail slot", () => {
    const markup = renderToStaticMarkup(
      createElement(StageRail, {
        stages: STAGES,
        focusedStage: "db",
        collapsedStages: {
          cards: true,
          threads: true,
        },
        onFocusStage: () => undefined,
      }),
    );

    expect(markup.match(/data-collapsed-group=\"true\"/g)?.length ?? 0).toBe(1);
  });

  test("supports the 4-stage order ending in diff", () => {
    const markup = renderToStaticMarkup(
      createElement(StageRail, {
        stages: STAGES,
        focusedStage: "files",
        onFocusStage: () => undefined,
      }),
    );

    expect(markup.includes(">Views<")).toBeTrue();
    expect(markup.includes(">Cards<")).toBeTrue();
    expect(markup.includes(">Threads<")).toBeTrue();
    expect(markup.includes(">Diffs<")).toBeTrue();
  });

  test("sliding-window mode renders requested visible panes", () => {
    const markup = renderToStaticMarkup(
      createElement(StageRail, {
        stages: STAGES,
        layoutMode: "sliding-window",
        focusedStage: "threads",
        stageNavDirection: "left",
        slidingWindowPaneCount: 3,
        onFocusStage: () => undefined,
      }),
    );

    expect(markup.includes("data-layout-mode=\"sliding-window\"")).toBeTrue();
    expect(markup.match(/data-stage-pane=\"window-/g)?.length ?? 0).toBe(3);
    expect(markup.match(/role=\"separator\"/g)?.length ?? 0).toBe(2);
  });

  test("sliding-window mode supports single-pane layout", () => {
    const markup = renderToStaticMarkup(
      createElement(StageRail, {
        stages: STAGES,
        layoutMode: "sliding-window",
        focusedStage: "cards",
        slidingWindowPaneCount: 1,
        onFocusStage: () => undefined,
      }),
    );

    expect(markup.includes("data-layout-mode=\"sliding-window\"")).toBeTrue();
    expect(markup.match(/data-stage-pane=\"window-/g)?.length ?? 0).toBe(1);
    expect(markup.match(/role=\"separator\"/g)?.length ?? 0).toBe(0);
  });
});
