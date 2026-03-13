import { describe, expect, test } from "bun:test";
import {
  resolveKanbanDragColumnId,
  shouldFreezeSameColumnPreview,
} from "./sortable-preview-mode";

describe("sortable preview mode", () => {
  test("resolves columnId from card drag data", () => {
    expect(
      resolveKanbanDragColumnId({
        data: {
          current: {
            columnId: "in_progress",
          },
        },
      }),
    ).toBe("in_progress");
  });

  test("resolves column id from column droppable data", () => {
    expect(
      resolveKanbanDragColumnId({
        data: {
          current: {
            column: {
              id: "done",
            },
          },
        },
      }),
    ).toBe("done");
  });

  test("freezes preview when active and over remain in the same column", () => {
    expect(
      shouldFreezeSameColumnPreview({
        columnId: "in_progress",
        isSorting: true,
        active: {
          data: {
            current: {
              columnId: "in_progress",
            },
          },
        },
        over: {
          data: {
            current: {
              columnId: "in_progress",
            },
          },
        },
      }),
    ).toBeTrue();
  });

  test("does not freeze preview when drag crosses columns", () => {
    expect(
      shouldFreezeSameColumnPreview({
        columnId: "in_progress",
        isSorting: true,
        active: {
          data: {
            current: {
              columnId: "in_progress",
            },
          },
        },
        over: {
          data: {
            current: {
              columnId: "done",
            },
          },
        },
      }),
    ).toBeFalse();
  });
});
