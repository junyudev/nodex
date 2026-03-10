import { describe, expect, test } from "bun:test";
import { mapCardToDroppedCardToggleBlock } from "./card-drop-toggle-mapper";
import { parseCardToggleSnapshot } from "./card-toggle-snapshot";

const BASE_CARD = {
  id: "card-1",
  title: "Dragged card",
  description: "First line\n\tChild line",
  priority: "p1-high" as const,
  estimate: "m" as const,
  tags: ["tag-a", "tag-b"],
  assignee: "alice",
  dueDate: new Date("2026-02-14T00:00:00.000Z"),
  scheduledStart: new Date("2026-02-14T09:00:00.000Z"),
  scheduledEnd: new Date("2026-02-14T10:30:00.000Z"),
  isAllDay: true,
  agentBlocked: true,
  agentStatus: "blocked",
  created: new Date("2026-02-14T00:00:00.000Z"),
  order: 3,
};

describe("card drop toggle mapper", () => {
  test("maps card into a cardToggle block with snapshot props", () => {
    const block = mapCardToDroppedCardToggleBlock(
      BASE_CARD,
      "default",
      "6-in-progress",
      "In Progress",
    );

    expect(block.type).toBe("cardToggle");
    expect(block.props.cardId).toBe("card-1");
    expect(block.props.sourceProjectId).toBe("default");
    expect(block.props.sourceColumnId).toBe("6-in-progress");
    expect(block.props.sourceColumnName).toBe("In Progress");
    expect(typeof block.props.snapshot).toBe("string");
    expect(block.props.snapshot.length > 0).toBeTrue();
  });

  test("preserves description blocks as cardToggle children", () => {
    const block = mapCardToDroppedCardToggleBlock(
      BASE_CARD,
      "default",
      "6-in-progress",
      "In Progress",
    );

    expect(Array.isArray(block.children)).toBeTrue();
    expect(block.children.length > 0).toBeTrue();
  });

  test("captures scheduled fields in the snapshot payload", () => {
    const block = mapCardToDroppedCardToggleBlock(
      BASE_CARD,
      "default",
      "6-in-progress",
      "In Progress",
    );
    const parsed = parseCardToggleSnapshot(block.props.snapshot);

    expect(parsed?.card?.scheduledStart).toBe("2026-02-14T09:00:00.000Z");
    expect(parsed?.card?.scheduledEnd).toBe("2026-02-14T10:30:00.000Z");
    expect(parsed?.card?.isAllDay).toBeTrue();
  });
});
