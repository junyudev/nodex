import { describe, expect, test } from "bun:test";
import {
  blockToCardPatch,
  cardToToggleBlock,
  hasCardToggleStructure,
  makeCardToggleBlockId,
} from "./block-mapping";
import type { ToggleListCard } from "./types";

function makeCard(overrides: Partial<ToggleListCard> = {}): ToggleListCard {
  return {
    id: "card-1",
    title: "Example card",
    description: "Line one\nLine two",
    priority: "p1-high",
    estimate: "xl",
    tags: ["editor"],
    agentBlocked: false,
    created: new Date("2026-02-10T00:00:00.000Z"),
    order: 0,
    columnId: "5-ready",
    columnName: "Ready",
    boardIndex: 7,
    ...overrides,
  };
}

describe("toggle-list block mapping", () => {
  test("makeCardToggleBlockId is stable and project scoped", () => {
    expect(makeCardToggleBlockId("alpha", "abc1234")).toBe("toggle-card-alpha-abc1234");
  });

  test("cardToToggleBlock and blockToCardPatch preserve title and description", () => {
    const card = makeCard({
      title: "Keep this title",
      description: "First paragraph\nSecond paragraph",
    });

    const block = cardToToggleBlock("proj-a", card, ["priority", "estimate", "status"], []);
    const patch = blockToCardPatch(block);

    expect(patch).not.toBeNull();
    if (!patch) return;

    expect(patch.cardId).toBe(card.id);
    expect(patch.title).toBe(card.title);
    expect(patch.description).toBe(card.description);
  });

  test("hasCardToggleStructure validates membership and order", () => {
    const blockA = cardToToggleBlock("proj-a", makeCard({ id: "a" }), ["priority", "estimate", "status"], []);
    const blockB = cardToToggleBlock("proj-a", makeCard({ id: "b" }), ["priority", "estimate", "status"], []);

    expect(hasCardToggleStructure([blockA, blockB], ["a", "b"])).toBeTrue();
    expect(hasCardToggleStructure([blockA, blockB], ["b", "a"])).toBeFalse();
    expect(hasCardToggleStructure([blockA], ["a", "b"])).toBeFalse();
  });

  test("hasCardToggleStructure treats empty expected list as valid when no card toggles remain", () => {
    const paragraphBlock = { id: "note", type: "paragraph", content: "No cards", children: [] };
    const cardBlock = cardToToggleBlock("proj-a", makeCard({ id: "a" }), ["priority", "estimate", "status"], []);

    expect(hasCardToggleStructure([paragraphBlock], [])).toBeTrue();
    expect(hasCardToggleStructure([cardBlock], [])).toBeFalse();
  });

  test("cardToToggleBlock collects toggle states when requested", () => {
    const card = makeCard({
      description: "▼ Open\n\tChild\n▶ Closed",
    });
    const toggleStates = new Map<string, boolean>();

    const block = cardToToggleBlock(
      "proj-a",
      card,
      ["priority", "estimate", "status"],
      [],
      toggleStates,
    );

    const children = block.children as Array<{ id?: string }>;
    expect(toggleStates.size).toBe(2);
    expect(children[0]?.id ? toggleStates.get(children[0].id) : undefined).toBe(true);
    expect(children[1]?.id ? toggleStates.get(children[1].id) : undefined).toBe(false);
  });

  test("cardToToggleBlock preserves cardRef blocks from description", () => {
    const card = makeCard({
      description: '<card-ref project="default" card="ref-123" />',
    });

    const block = cardToToggleBlock("proj-a", card, ["priority", "estimate", "status"], []);
    const firstChild = (block.children as Array<{ type?: string }>)[0];

    expect(firstChild?.type).toBe("cardRef");
  });
});
