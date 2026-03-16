import { describe, expect, test } from "bun:test";
import {
  KANBAN_BOARD_SCROLL_CONTAINER_TEST_ID,
  KanbanBoardScrollContainer,
  TOGGLE_LIST_SCROLL_CONTAINER_TEST_ID,
  ToggleListScrollContainer,
} from "./view-scroll-containers";
import { render } from "../../test/dom";

describe("view scroll containers", () => {
  test("kanban wrapper provides bidirectional scroll semantics", () => {
    const { getByTestId } = render(
      <KanbanBoardScrollContainer>
        <div id="content" />
      </KanbanBoardScrollContainer>,
    );

    const wrapper = getByTestId(KANBAN_BOARD_SCROLL_CONTAINER_TEST_ID);
    expect(wrapper.className.includes("overflow-auto")).toBeTrue();
    expect(wrapper.className.includes("hide-scrollbar")).toBeTrue();
  });

  test("toggle-list wrapper provides vertical scroll semantics", () => {
    const { getByTestId } = render(
      <ToggleListScrollContainer>
        <div id="content" />
      </ToggleListScrollContainer>,
    );

    const wrapper = getByTestId(TOGGLE_LIST_SCROLL_CONTAINER_TEST_ID);
    expect(wrapper.className.includes("overflow-y-auto")).toBeTrue();
    expect(wrapper.className.includes("scrollbar-token")).toBeTrue();
  });
});
