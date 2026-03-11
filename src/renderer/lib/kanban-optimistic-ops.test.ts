import { describe, expect, test } from "bun:test";
import { createOptimisticCard } from "./kanban-optimistic-ops";

describe("kanban optimistic ops", () => {
  test("creates optimistic cards without a default priority", () => {
    const card = createOptimisticCard({
      title: "Optimistic card",
    });

    expect(card.priority ?? null).toBe(null);
  });
});
