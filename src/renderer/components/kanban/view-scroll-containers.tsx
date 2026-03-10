import type { ReactNode } from "react";

export const KANBAN_BOARD_SCROLL_CONTAINER_TEST_ID = "kanban-board-scroll-container";
export const TOGGLE_LIST_SCROLL_CONTAINER_TEST_ID = "toggle-list-scroll-container";

export function KanbanBoardScrollContainer({ children }: { children: ReactNode }) {
  return (
    <div
      className="hide-scrollbar min-h-0 flex-1 overflow-auto"
      data-testid={KANBAN_BOARD_SCROLL_CONTAINER_TEST_ID}
    >
      {children}
    </div>
  );
}

export function ToggleListScrollContainer({ children }: { children: ReactNode }) {
  return (
    <div
      className="notion-scrollbar h-full min-h-0 overflow-y-auto"
      data-testid={TOGGLE_LIST_SCROLL_CONTAINER_TEST_ID}
    >
      {children}
    </div>
  );
}
