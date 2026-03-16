import { describe, expect, test } from "bun:test";
import { resolveKanbanCardDropStrategy } from "./kanban-card-drop-strategy";

describe("resolveKanbanCardDropStrategy", () => {
  test("keeps visible-slot reordering enabled when kanban uses the default board sort", () => {
    const strategy = resolveKanbanCardDropStrategy({
      hasNonDefaultSort: false,
      destinationColumnId: "in_progress",
      dragItems: [
        { columnId: "in_progress" },
      ],
    });

    expect(strategy).toBe("reorder");
  });

  test("treats sorted same-column drops as no-op manual ranking", () => {
    const strategy = resolveKanbanCardDropStrategy({
      hasNonDefaultSort: true,
      destinationColumnId: "in_progress",
      dragItems: [
        { columnId: "in_progress" },
      ],
    });

    expect(strategy).toBe("none");
  });

  test("allows sorted drops that move at least one dragged card into another column", () => {
    const strategy = resolveKanbanCardDropStrategy({
      hasNonDefaultSort: true,
      destinationColumnId: "done",
      dragItems: [
        { columnId: "in_progress" },
        { columnId: "done" },
      ],
    });

    expect(strategy).toBe("move-only");
  });

  test("keeps sorted multi-card same-column drops disabled when no card changes status", () => {
    const strategy = resolveKanbanCardDropStrategy({
      hasNonDefaultSort: true,
      destinationColumnId: "in_review",
      dragItems: [
        { columnId: "in_review" },
        { columnId: "in_review" },
      ],
    });

    expect(strategy).toBe("none");
  });
});
