import { describe, expect, test } from "bun:test";
import { cardToToggleBlock } from "./block-mapping";
import { buildInboundUpdates, buildOutboundPatches } from "./sync";
import type { ToggleListCard } from "./types";

function makeCard(overrides: Partial<ToggleListCard> = {}): ToggleListCard {
  return {
    id: "card-1",
    status: "backlog",
    archived: false,
    title: "Base title",
    description: "Base description",
    priority: "p2-medium",
    estimate: "m",
    tags: [],
    agentBlocked: false,
    created: new Date("2026-02-10T00:00:00.000Z"),
    order: 0,
    columnId: "backlog",
    columnName: "Backlog",
    boardIndex: 0,
    ...overrides,
  };
}

describe("toggle-list sync helpers", () => {
  test("buildOutboundPatches returns only changed cards", () => {
    const cardA = makeCard({ id: "a", title: "Keep" });
    const cardB = makeCard({ id: "b", title: "Original" });

    const unchanged = cardToToggleBlock("proj", cardA, ["priority", "estimate", "status"], []);
    const changed = cardToToggleBlock(
      "proj",
      { ...cardB, title: "Edited title", description: "Edited description" },
      ["priority", "estimate", "status"],
      [],
    );

    const patches = buildOutboundPatches(
      [unchanged, changed],
      new Map([
        [cardA.id, cardA],
        [cardB.id, cardB],
      ]),
    );

    expect(patches.length).toBe(1);
    expect(patches[0].cardId).toBe("b");
    expect(patches[0].updates.title).toBe("Edited title");
    expect(patches[0].updates.description).toBe("Edited description");
  });

  test("buildInboundUpdates patches meta when visibility/order rules change", () => {
    const card = makeCard({ id: "a", priority: "p0-critical", estimate: "xl" });
    const block = cardToToggleBlock("proj", card, ["priority", "estimate", "status"], []);

    const updates = buildInboundUpdates(
      [block],
      new Map([[card.id, card]]),
      ["status", "priority", "estimate"],
      ["estimate"],
      new Set<string>(),
      new Set<string>(),
    );

    expect(updates.length).toBe(1);
    expect(updates[0].update.props?.meta).toBe("[Backlog] [P0]");
    expect(updates[0].update.content).toBe(undefined);
    expect(updates[0].update.children).toBe(undefined);
    expect(updates[0].toggleStates).toBe(undefined);
  });

  test("buildInboundUpdates skips dirty or in-flight cards", () => {
    const card = makeCard({ id: "a", title: "Server title" });
    const staleBlock = cardToToggleBlock("proj", { ...card, title: "Local edit" }, ["priority", "estimate", "status"], []);

    const updates = buildInboundUpdates(
      [staleBlock],
      new Map([[card.id, card]]),
      ["priority", "estimate", "status"],
      [],
      new Set(["a"]),
      new Set<string>(),
    );

    expect(updates.length).toBe(0);
  });

  test("buildInboundUpdates includes toggleStates when description changes", () => {
    const card = makeCard({
      id: "a",
      description: "▼ Open\n\tChild paragraph\n▶ Closed",
    });
    const staleBlock = cardToToggleBlock(
      "proj",
      { ...card, description: "▶ Open\n\tChild paragraph\n▶ Closed" },
      ["priority", "estimate", "status"],
      [],
    );

    const updates = buildInboundUpdates(
      [staleBlock],
      new Map([[card.id, card]]),
      ["priority", "estimate", "status"],
      [],
      new Set<string>(),
      new Set<string>(),
    );

    expect(updates.length).toBe(1);
    expect(updates[0].update.children === undefined).toBeFalse();
    expect(updates[0].toggleStates === undefined).toBeFalse();
    if (!updates[0].toggleStates) return;
    expect([...updates[0].toggleStates.values()].some((isOpen) => isOpen)).toBeTrue();
  });

  test("buildInboundUpdates does not produce spurious update when toggle state matches via DOM", () => {
    const card = makeCard({
      id: "a",
      description: "▼ Open toggle\n\tChild paragraph",
    });
    const toggleStates = new Map<string, boolean>();
    const block = cardToToggleBlock(
      "proj",
      card,
      ["priority", "estimate", "status"],
      [],
      toggleStates,
    );

    const childToggleId = (block.children as Array<{ id?: string }>)[0]?.id;
    expect(typeof childToggleId).toBe("string");
    if (!childToggleId) return;

    const originalCss = globalThis.CSS;
    (globalThis as { CSS?: { escape: (value: string) => string } }).CSS = {
      escape: (value) => value,
    };

    // Mock DOM that reports toggle as open (matching the card description)
    const editorElement = {
      querySelector: (selector: string) => {
        if (!selector.includes(childToggleId)) return null;
        return {
          getAttribute: (name: string) => (name === "data-show-children" ? "true" : null),
        };
      },
    } as unknown as HTMLElement;

    try {
      const updates = buildInboundUpdates(
        [block],
        new Map([[card.id, card]]),
        ["priority", "estimate", "status"],
        [],
        new Set<string>(),
        new Set<string>(),
        editorElement,
      );

      // No update should be produced since DOM toggle state matches card description
      expect(updates.length).toBe(0);
    } finally {
      if (originalCss) {
        (globalThis as { CSS?: { escape: (value: string) => string } }).CSS = originalCss;
      } else {
        delete (globalThis as { CSS?: { escape: (value: string) => string } }).CSS;
      }
    }
  });

  test("buildOutboundPatches reads toggle DOM state when editor element is provided", () => {
    const card = makeCard({
      id: "a",
      description: "▶ Collapsed toggle",
    });
    const toggleStates = new Map<string, boolean>();
    const block = cardToToggleBlock(
      "proj",
      card,
      ["priority", "estimate", "status"],
      [],
      toggleStates,
    );

    const childToggleId = (block.children as Array<{ id?: string }>)[0]?.id;
    expect(typeof childToggleId).toBe("string");
    if (!childToggleId) return;

    const originalCss = globalThis.CSS;
    (globalThis as { CSS?: { escape: (value: string) => string } }).CSS = {
      escape: (value) => value,
    };

    const editorElement = {
      querySelector: (selector: string) => {
        if (!selector.includes(childToggleId)) return null;
        return {
          getAttribute: (name: string) => (name === "data-show-children" ? "true" : null),
        };
      },
    } as unknown as HTMLElement;

    try {
      const patches = buildOutboundPatches(
        [block],
        new Map([[card.id, card]]),
        editorElement,
      );

      expect(patches.length).toBe(1);
      expect(patches[0].updates.description).toBe("▼ Collapsed toggle");
    } finally {
      if (originalCss) {
        (globalThis as { CSS?: { escape: (value: string) => string } }).CSS = originalCss;
      } else {
        delete (globalThis as { CSS?: { escape: (value: string) => string } }).CSS;
      }
    }
  });
});
