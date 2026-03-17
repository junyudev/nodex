import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { Column } from "./column";
import { render } from "@/test/dom";

describe("Column", () => {
  test("applies the drop-target surface styling when the column is the active sorted drop target", () => {
    const { container } = render(createElement(Column, {
      projectId: "default",
      projectName: "Default",
      column: {
        id: "in_progress",
        name: "In Progress",
        cards: [
          {
            id: "card-1",
            status: "in_progress",
            archived: false,
            title: "Task",
            description: "",
            tags: [],
            agentBlocked: false,
            created: new Date("2026-03-17T00:00:00.000Z"),
            order: 0,
          },
        ],
      },
      layout: {
        width: 320,
        collapsed: false,
      },
      onAddCard: async () => {},
      onEditCard: () => {},
      onUpdateCardProperty: async () => {},
      onCollapsedChange: () => {},
      onWidthChange: () => {},
      isDropTargetActive: true,
      cardDropDisabled: true,
    }));

    const columnSurface = container.querySelector(".rounded-t-lg");
    expect(columnSurface?.className.includes("bg-[var(--column-in-progress-drop-bg)]")).toBeTrue();
  });

  test("renders the blocked-sort feedback message in the header", () => {
    const { container } = render(createElement(Column, {
      projectId: "default",
      projectName: "Default",
      column: {
        id: "in_progress",
        name: "In Progress",
        cards: [
          {
            id: "card-1",
            status: "in_progress",
            archived: false,
            title: "Task",
            description: "",
            tags: [],
            agentBlocked: false,
            created: new Date("2026-03-17T00:00:00.000Z"),
            order: 0,
          },
        ],
      },
      layout: {
        width: 320,
        collapsed: false,
      },
      onAddCard: async () => {},
      onEditCard: () => {},
      onUpdateCardProperty: async () => {},
      onCollapsedChange: () => {},
      onWidthChange: () => {},
      dropBlockedMessage: "Sorted by title; switch to Board Order to manually rank.",
    }));

    expect(container.textContent?.includes("Sorted by title; switch to Board Order to manually rank.")).toBeTrue();
  });
});
