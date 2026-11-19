import { describe, expect, it } from "vitest";
import { layoutMarginCards, type MarginCardInput } from "./margin-layout";

const card = (id: string, anchorTop: number, height = 40): MarginCardInput => ({
  id,
  anchorTop,
  height,
});

function assertNoOverlap(
  cards: readonly MarginCardInput[],
  tops: ReadonlyMap<string, number>,
  gap: number,
) {
  const placed = cards
    .map((c) => ({ top: tops.get(c.id)!, bottom: tops.get(c.id)! + c.height }))
    .toSorted((a, b) => a.top - b.top);
  for (let index = 1; index < placed.length; index += 1) {
    expect(placed[index]!.top).toBeGreaterThanOrEqual(placed[index - 1]!.bottom + gap);
  }
}

describe("layoutMarginCards", () => {
  it("keeps cards at their anchors when they do not collide", () => {
    const tops = layoutMarginCards([card("a", 0), card("b", 100)], { gap: 8 });
    expect([...tops]).toEqual([
      ["a", 0],
      ["b", 100],
    ]);
  });

  it("pushes colliding cards down in document order", () => {
    const cards = [card("b", 10), card("a", 0), card("c", 20)];
    const tops = layoutMarginCards(cards, { gap: 8 });
    expect(tops.get("a")).toBe(0);
    expect(tops.get("b")).toBe(48);
    expect(tops.get("c")).toBe(96);
    assertNoOverlap(cards, tops, 8);
  });

  it("pins the active card to its anchor and pushes earlier cards up", () => {
    const cards = [card("a", 100), card("b", 110), card("c", 120)];
    const tops = layoutMarginCards(cards, { gap: 8, activeId: "b" });
    expect(tops.get("b")).toBe(110);
    expect(tops.get("a")).toBe(62);
    expect(tops.get("c")).toBe(158);
    assertNoOverlap(cards, tops, 8);
  });

  it("shifts the column down when the active card has no room above the boundary", () => {
    const cards = [card("a", 0), card("b", 10)];
    const tops = layoutMarginCards(cards, { gap: 8, activeId: "b", minTop: 0 });
    expect(tops.get("a")).toBe(0);
    expect(tops.get("b")).toBe(48);
    assertNoOverlap(cards, tops, 8);
  });

  it("ignores an active id that is not in the column", () => {
    const tops = layoutMarginCards([card("a", 5)], { gap: 8, activeId: "missing", minTop: 0 });
    expect(tops.get("a")).toBe(5);
  });

  it("keeps equal anchors in input order", () => {
    const tops = layoutMarginCards([card("first", 50), card("second", 50)], { gap: 4 });
    expect(tops.get("first")).toBe(50);
    expect(tops.get("second")).toBe(94);
  });
});
