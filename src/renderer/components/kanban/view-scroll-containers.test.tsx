import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  KANBAN_BOARD_SCROLL_CONTAINER_TEST_ID,
  KanbanBoardScrollContainer,
  TOGGLE_LIST_SCROLL_CONTAINER_TEST_ID,
  ToggleListScrollContainer,
} from "./view-scroll-containers";

describe("view scroll containers", () => {
  test("kanban wrapper provides bidirectional scroll semantics", () => {
    const markup = renderToStaticMarkup(
      createElement(
        KanbanBoardScrollContainer,
        undefined,
        createElement("div", { id: "content" }),
      ),
    );

    expect(markup.includes(`data-testid="${KANBAN_BOARD_SCROLL_CONTAINER_TEST_ID}"`)).toBeTrue();
    expect(markup.includes("overflow-auto")).toBeTrue();
    expect(markup.includes("hide-scrollbar")).toBeTrue();
  });

  test("toggle-list wrapper provides vertical scroll semantics", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ToggleListScrollContainer,
        undefined,
        createElement("div", { id: "content" }),
      ),
    );

    expect(markup.includes(`data-testid="${TOGGLE_LIST_SCROLL_CONTAINER_TEST_ID}"`)).toBeTrue();
    expect(markup.includes("overflow-y-auto")).toBeTrue();
    expect(markup.includes("notion-scrollbar")).toBeTrue();
  });
});
