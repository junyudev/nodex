import { describe, expect, test } from "bun:test";
import { resolveSendBlockSelection } from "./send-block-selection";

interface TestBlock {
  id: string;
  type: string;
  children?: TestBlock[];
}

function createEditor(blocks: TestBlock[]) {
  const blockById = new Map<string, TestBlock>();
  const parentById = new Map<string, TestBlock>();

  const walk = (nodes: TestBlock[], parent?: TestBlock) => {
    for (const node of nodes) {
      blockById.set(node.id, node);
      if (parent) parentById.set(node.id, parent);
      walk(node.children ?? [], node);
    }
  };

  walk(blocks);

  const pmSelection: {
    nodes?: Array<{ attrs?: { id?: string } }>;
  } = {};

  return {
    document: blocks,
    prosemirrorView: {
      state: {
        selection: pmSelection,
      },
    },
    getSelection: () => undefined,
    getBlock: (id: string) => blockById.get(id),
    getParentBlock: (id: string) => parentById.get(id),
    removeBlocks: () => {},
    replaceBlocks: () => {},
    setSelectedIds(ids: string[]) {
      pmSelection.nodes = ids.map((id) => ({ attrs: { id } }));
    },
  };
}

function createContainer(): HTMLElement {
  return {
    querySelector: () => null,
  } as unknown as HTMLElement;
}

describe("resolveSendBlockSelection", () => {
  test("uses current block selection when available", () => {
    const editor = createEditor([
      { id: "a", type: "paragraph" },
      { id: "b", type: "paragraph" },
    ]);
    editor.setSelectedIds(["a", "b"]);

    const result = resolveSendBlockSelection(editor, createContainer(), "fallback");

    expect(JSON.stringify(result.blockIds)).toBe(JSON.stringify(["a", "b"]));
    expect(JSON.stringify(result.blocks.map((block) => block.id))).toBe(JSON.stringify(["a", "b"]));
  });

  test("falls back to drag-handle block when no selection exists", () => {
    const editor = createEditor([
      { id: "fallback", type: "paragraph" },
    ]);

    const result = resolveSendBlockSelection(editor, createContainer(), "fallback");

    expect(JSON.stringify(result.blockIds)).toBe(JSON.stringify(["fallback"]));
  });

  test("keeps only top-level selection when parent and child are both selected", () => {
    const editor = createEditor([
      {
        id: "parent",
        type: "toggleListItem",
        children: [{ id: "child", type: "paragraph" }],
      },
    ]);
    editor.setSelectedIds(["parent", "child"]);

    const result = resolveSendBlockSelection(editor, createContainer(), "fallback");

    expect(JSON.stringify(result.blockIds)).toBe(JSON.stringify(["parent"]));
  });

  test("returns empty when fallback block id does not exist", () => {
    const editor = createEditor([{ id: "one", type: "paragraph" }]);

    const result = resolveSendBlockSelection(editor, createContainer(), "missing");

    expect(result.blockIds.length).toBe(0);
    expect(result.blocks.length).toBe(0);
  });
});
