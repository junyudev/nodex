import { describe, expect, test } from "bun:test";
import { resolveCardRefOwnerDragBlock } from "./side-menu-drag-target";

interface TestBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
}

function createEditor(
  blocks: TestBlock[],
  parentById: Record<string, string | undefined> = {},
) {
  const blockMap = new Map(blocks.map((block) => [block.id, block]));
  return {
    getBlock: (blockId: string) => blockMap.get(blockId),
    getParentBlock: (blockId: string) => {
      const parentId = parentById[blockId];
      if (!parentId) return undefined;
      return blockMap.get(parentId);
    },
  };
}

describe("resolveCardRefOwnerDragBlock", () => {
  test("keeps source block when it is not projected", () => {
    const paragraph = { id: "p-1", type: "paragraph" };
    const editor = createEditor([paragraph]);

    expect(resolveCardRefOwnerDragBlock(editor, paragraph)).toBe(paragraph);
  });

  test("maps projected card row block to cardRef owner block", () => {
    const owner = { id: "owner-1", type: "cardRef" };
    const projected = {
      id: "row-1",
      type: "cardToggle",
      props: {
        projectionOwnerId: owner.id,
        projectionCardId: "card-1",
        projectionSourceProjectId: "default",
      },
    };
    const editor = createEditor([owner, projected], {
      [projected.id]: owner.id,
    });

    expect(resolveCardRefOwnerDragBlock(editor, projected)).toBe(owner);
  });

  test("does not remap descendants of projected rows", () => {
    const owner = { id: "owner-1", type: "cardRef" };
    const projected = {
      id: "row-1",
      type: "cardToggle",
      props: {
        projectionOwnerId: owner.id,
        projectionCardId: "card-1",
        projectionSourceProjectId: "default",
      },
    };
    const child = { id: "row-child", type: "paragraph" };
    const editor = createEditor([owner, projected, child], {
      [projected.id]: owner.id,
      [child.id]: projected.id,
    });

    expect(resolveCardRefOwnerDragBlock(editor, child)).toBe(child);
  });

  test("does not remap projected rows owned by non-cardRef blocks", () => {
    const owner = { id: "owner-1", type: "toggleListInlineView" };
    const projected = {
      id: "row-1",
      type: "cardToggle",
      props: {
        projectionOwnerId: owner.id,
        projectionCardId: "card-1",
        projectionSourceProjectId: "default",
      },
    };
    const editor = createEditor([owner, projected], {
      [projected.id]: owner.id,
    });

    expect(resolveCardRefOwnerDragBlock(editor, projected)).toBe(projected);
  });
});
