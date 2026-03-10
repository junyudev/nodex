import { describe, expect, test } from "bun:test";
import type { ToggleListCard } from "../../../lib/toggle-list/types";
import type { ProjectedCardPatch } from "./projection-card-toggle";
import {
  getReadyProjectedPatches,
  isBlockWithinOwnerTree,
  isCursorWithinOwnerTree,
  isProjectedPatchDirty,
  mergeProjectedPatchesIntoPending,
} from "./use-projected-card-embed-sync";

function makeCard(overrides: Partial<ToggleListCard> = {}): ToggleListCard {
  return {
    id: "card-1",
    title: "Initial title",
    description: "Initial description",
    priority: "p1-high",
    estimate: "m",
    tags: [],
    agentBlocked: false,
    created: new Date("2026-02-16T00:00:00.000Z"),
    order: 0,
    columnId: "3-backlog",
    columnName: "Backlog",
    boardIndex: 0,
    ...overrides,
  };
}

function makePatch(overrides: Partial<ProjectedCardPatch> = {}): ProjectedCardPatch {
  const overrideUpdates = overrides.updates ?? {};
  const nextUpdates = {
    title: "Patched title",
    description: "Patched description",
    ...overrideUpdates,
  };

  return {
    cardId: "card-1",
    sourceProjectId: "default",
    ...overrides,
    updates: nextUpdates,
  };
}

describe("projected card embed sync helpers", () => {
  test("isBlockWithinOwnerTree returns true when owner is an ancestor", () => {
    const parents = new Map<string, string | undefined>([
      ["leaf", "child"],
      ["child", "owner"],
      ["owner", undefined],
    ]);

    const result = isBlockWithinOwnerTree(
      (id) => {
        const parentId = parents.get(id);
        return parentId ? { id: parentId } : undefined;
      },
      "owner",
      "leaf",
    );

    expect(result).toBeTrue();
  });

  test("isBlockWithinOwnerTree handles non-ancestor and cyclic parents safely", () => {
    const parents = new Map<string, string | undefined>([
      ["leaf", "other"],
      ["other", "loop"],
      ["loop", "other"],
    ]);

    const result = isBlockWithinOwnerTree(
      (id) => {
        const parentId = parents.get(id);
        return parentId ? { id: parentId } : undefined;
      },
      "owner",
      "leaf",
    );

    expect(result).toBeFalse();
  });

  test("isCursorWithinOwnerTree preserves method binding for this-based editors", () => {
    class ThisBoundEditor {
      cursorBlockId = "leaf";

      readonly parents = new Map<string, string | undefined>([
        ["leaf", "child"],
        ["child", "owner"],
        ["owner", undefined],
      ]);

      getTextCursorPosition() {
        return {
          block: {
            id: this.cursorBlockId,
          },
        };
      }

      getParentBlock(id: string) {
        const parentId = this.parents.get(id);
        return parentId ? { id: parentId } : undefined;
      }
    }

    const editor = new ThisBoundEditor();
    const result = isCursorWithinOwnerTree(editor, "owner");
    expect(result).toBeTrue();
  });

  test("mergeProjectedPatchesIntoPending keeps latest patch per card", () => {
    const card = makeCard();
    const cardById = new Map([[card.id, card]]);
    const pending = new Map<string, ProjectedCardPatch>();

    mergeProjectedPatchesIntoPending(
      pending,
      [makePatch({ updates: { title: "First title" } })],
      cardById,
    );

    mergeProjectedPatchesIntoPending(
      pending,
      [makePatch({ updates: { title: "Latest title" } })],
      cardById,
    );

    expect(pending.size).toBe(1);
    expect(pending.get(card.id)?.updates.title).toBe("Latest title");
  });

  test("mergeProjectedPatchesIntoPending removes clean patches that match card state", () => {
    const card = makeCard({ title: "Saved", description: "Saved desc" });
    const cardById = new Map([[card.id, card]]);
    const pending = new Map<string, ProjectedCardPatch>([
      [card.id, makePatch({ updates: { title: "Dirty", description: "Dirty desc" } })],
    ]);

    mergeProjectedPatchesIntoPending(
      pending,
      [makePatch({ updates: { title: "Saved", description: "Saved desc" } })],
      cardById,
    );

    expect(pending.has(card.id)).toBeFalse();
  });

  test("getReadyProjectedPatches excludes in-flight card ids", () => {
    const pending = new Map<string, ProjectedCardPatch>([
      ["card-1", makePatch({ cardId: "card-1" })],
      ["card-2", makePatch({ cardId: "card-2" })],
    ]);

    const ready = getReadyProjectedPatches(pending, new Set(["card-1"]));
    expect(ready.length).toBe(1);
    expect(ready[0]?.cardId).toBe("card-2");
  });

  test("queue replay semantics keep newer patch while earlier one is in-flight", () => {
    const card = makeCard();
    const cardById = new Map([[card.id, card]]);
    const pending = new Map<string, ProjectedCardPatch>();
    const inFlight = new Set<string>([card.id]);

    const firstPatch = makePatch({ updates: { title: "First" } });
    mergeProjectedPatchesIntoPending(pending, [firstPatch], cardById);

    const secondPatch = makePatch({ updates: { title: "Second" } });
    mergeProjectedPatchesIntoPending(pending, [secondPatch], cardById);

    const readyWhileInFlight = getReadyProjectedPatches(pending, inFlight);
    expect(readyWhileInFlight.length).toBe(0);

    inFlight.delete(card.id);
    const readyAfterInFlight = getReadyProjectedPatches(pending, inFlight);
    expect(readyAfterInFlight.length).toBe(1);
    expect(readyAfterInFlight[0]?.updates.title).toBe("Second");
  });

  test("isProjectedPatchDirty detects no-op vs changed values", () => {
    const card = makeCard({ title: "Same", description: "Same desc" });

    expect(isProjectedPatchDirty(
      makePatch({ updates: { title: "Same", description: "Same desc" } }),
      card,
    )).toBeFalse();

    expect(isProjectedPatchDirty(
      makePatch({ updates: { title: "Changed", description: "Same desc" } }),
      card,
    )).toBeTrue();
  });

  test("isProjectedPatchDirty treats status moves as dirty", () => {
    const card = makeCard({ columnId: "3-backlog" });
    expect(isProjectedPatchDirty(
      makePatch({ targetColumnId: "8-done", updates: { title: card.title, description: card.description } }),
      card,
    )).toBeTrue();
  });
});
