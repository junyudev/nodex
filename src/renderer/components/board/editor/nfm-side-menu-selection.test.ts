import { describe, expect, test } from "vite-plus/test";
import { MultipleNodeSelection } from "@blocknote/core/extensions";
import { Schema, type Node } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import {
  applySideMenuSelectionIntent,
  createSideMenuDragSelectionSnapshot,
  createSideMenuSelectionIntent,
  expandSideMenuSelectionBlocksWithChildren,
  type SideMenuSelectionBlock,
} from "./nfm-side-menu-selection";

function block(id: string, children?: SideMenuSelectionBlock[]): SideMenuSelectionBlock {
  return { id, ...(children ? { children } : {}) };
}

const pmSchema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "block*" },
    block: {
      attrs: { id: {} },
      content: "text*",
      group: "bnBlock block",
      toDOM: (node) => ["div", { "data-id": node.attrs.id }, 0],
      parseDOM: [{ tag: "div[data-id]" }],
    },
    text: { group: "inline" },
  },
  marks: {},
});

function pmBlock(id: string, text = id) {
  return pmSchema.node("block", { id }, pmSchema.text(text));
}

function pmDocWithIds(ids: string[]) {
  return pmSchema.node("doc", null, [
    pmSchema.node(
      "blockGroup",
      null,
      ids.map((id) => pmBlock(id)),
    ),
  ]);
}

function pmDoc() {
  return pmDocWithIds(["a", "b", "c"]);
}

function blockPosition(doc: Node, blockId: string) {
  const matches: Array<{ node: Node; posBeforeNode: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "block" || node.attrs.id !== blockId) return true;
    matches.push({ node, posBeforeNode: pos });
    return false;
  });
  const result = matches[0];
  if (!result) throw new Error(`Missing test block ${blockId}`);
  return result;
}

function editorState(selection: EditorState["selection"]) {
  return EditorState.create({
    schema: pmSchema,
    doc: selection.$anchor.doc,
    selection,
  });
}

describe("markdown side menu selection helpers", () => {
  test("keeps the active selection when it contains the clicked block", () => {
    const clickedBlock = block("b");
    const intent = createSideMenuSelectionIntent(
      {
        getSelection: () => ({
          blocks: [block("a"), clickedBlock, block("c")],
        }),
      },
      clickedBlock,
    );

    expect(intent.source).toBe("active-selection");
    expect(intent.blocks.map((entry) => entry.id).join(",")).toBe("a,b,c");
  });

  test("expands selected blocks to include descendants in document order", () => {
    const clickedBlock = block("b", [block("b1"), block("b2", [block("b2a")])]);
    const intent = createSideMenuSelectionIntent(
      {
        getSelection: () => ({
          blocks: [block("a"), clickedBlock],
        }),
      },
      clickedBlock,
    );

    expect(intent.source).toBe("active-selection");
    expect(intent.blocks.map((entry) => entry.id).join(",")).toBe("a,b,b1,b2,b2a");
  });

  test("uses only the clicked block when the active selection is elsewhere", () => {
    const clickedBlock = block("b", [block("b1")]);
    const intent = createSideMenuSelectionIntent(
      {
        getSelection: () => ({
          blocks: [block("x"), block("y")],
        }),
      },
      clickedBlock,
    );

    expect(intent.source).toBe("clicked-block");
    expect(intent.blocks.map((entry) => entry.id).join(",")).toBe("b,b1");
  });

  test("uses only the clicked block when there is no active block selection", () => {
    const clickedBlock = block("b");
    const intent = createSideMenuSelectionIntent(
      {
        getSelection: () => undefined,
      },
      clickedBlock,
    );

    expect(intent.source).toBe("clicked-block");
    expect(intent.blocks.map((entry) => entry.id).join(",")).toBe("b");
  });

  test("uses ProseMirror block selection ids before public selection blocks", () => {
    const doc = pmDocWithIds(["a", "b", "c", "d"]);
    const startPosition = blockPosition(doc, "b");
    const endPosition = blockPosition(doc, "c");
    const clickedBlock = block("b");
    const intent = createSideMenuSelectionIntent(
      {
        getSelection: () => ({
          blocks: [clickedBlock, block("c"), block("d")],
        }),
        prosemirrorView: {
          state: editorState(
            MultipleNodeSelection.create(
              doc,
              startPosition.posBeforeNode,
              endPosition.posBeforeNode + endPosition.node.nodeSize,
            ),
          ),
          dispatch: () => {},
        },
      },
      clickedBlock,
    );

    expect(intent.source).toBe("active-selection");
    expect(intent.blocks.map((entry) => entry.id).join(",")).toBe("b,c");
  });

  test("maps a text selection spanning blocks to the public selected block range", () => {
    const doc = pmDocWithIds(["a", "b", "c", "d"]);
    const startPosition = blockPosition(doc, "b");
    const endPosition = blockPosition(doc, "c");
    const clickedBlock = block("b");
    const intent = createSideMenuSelectionIntent(
      {
        getSelection: () => ({
          blocks: [clickedBlock, block("c")],
        }),
        prosemirrorView: {
          state: editorState(
            TextSelection.create(
              doc,
              startPosition.posBeforeNode + 1,
              endPosition.posBeforeNode + endPosition.node.nodeSize - 1,
            ),
          ),
          dispatch: () => {},
        },
      },
      clickedBlock,
    );

    expect(intent.source).toBe("active-selection");
    expect(intent.blocks.map((entry) => entry.id).join(",")).toBe("b,c");
  });

  test("keeps repeated side-menu clicks from expanding a block selection", () => {
    const doc = pmDocWithIds(["a", "b", "c", "d"]);
    const startPosition = blockPosition(doc, "b");
    const endPosition = blockPosition(doc, "c");
    const clickedBlock = block("c");
    const blockSelection = MultipleNodeSelection.create(
      doc,
      startPosition.posBeforeNode,
      endPosition.posBeforeNode + endPosition.node.nodeSize,
    );

    const intent = createSideMenuSelectionIntent(
      {
        getSelection: () => ({
          blocks: [block("b"), clickedBlock, block("d")],
        }),
        prosemirrorView: {
          state: editorState(blockSelection),
          dispatch: () => {},
        },
      },
      clickedBlock,
    );

    expect(intent.source).toBe("active-selection");
    expect(intent.blocks.map((entry) => entry.id).join(",")).toBe("b,c");
  });

  test("reads a node selection through getBlock when public selection is absent", () => {
    const doc = pmDoc();
    const position = blockPosition(doc, "b");
    const clickedBlock = block("b");
    const intent = createSideMenuSelectionIntent(
      {
        getSelection: () => undefined,
        getBlock: (blockId) => (blockId === "b" ? clickedBlock : undefined),
        prosemirrorView: {
          state: editorState(NodeSelection.create(doc, position.posBeforeNode)),
          dispatch: () => {},
        },
      },
      clickedBlock,
    );

    expect(intent.source).toBe("active-selection");
    expect(intent.blocks.map((entry) => entry.id).join(",")).toBe("b");
  });

  test("ignores stale public blocks when the clicked block is outside the PM block selection", () => {
    const doc = pmDocWithIds(["a", "b", "c", "d"]);
    const startPosition = blockPosition(doc, "b");
    const endPosition = blockPosition(doc, "c");
    const clickedBlock = block("d");
    const intent = createSideMenuSelectionIntent(
      {
        getSelection: () => ({
          blocks: [block("b"), block("c"), clickedBlock],
        }),
        prosemirrorView: {
          state: editorState(
            MultipleNodeSelection.create(
              doc,
              startPosition.posBeforeNode,
              endPosition.posBeforeNode + endPosition.node.nodeSize,
            ),
          ),
          dispatch: () => {},
        },
      },
      clickedBlock,
    );

    expect(intent.source).toBe("clicked-block");
    expect(intent.blocks.map((entry) => entry.id).join(",")).toBe("d");
  });

  test("snapshots a text selection as raw ProseMirror bounds", () => {
    const doc = pmDoc();
    const position = blockPosition(doc, "b");
    const selectionFrom = position.posBeforeNode + 1;
    const selectionTo = selectionFrom + 1;
    const snapshot = createSideMenuDragSelectionSnapshot({
      prosemirrorView: {
        state: editorState(TextSelection.create(doc, selectionFrom, selectionTo)),
        dispatch: () => {},
      },
    });

    expect(snapshot?.selectionFrom).toBe(selectionFrom);
    expect(snapshot?.selectionTo).toBe(selectionTo);
    expect(snapshot?.selectedBlockIds === undefined).toBe(true);
  });

  test("snapshots a multiple block selection as block ids", () => {
    const doc = pmDoc();
    const startPosition = blockPosition(doc, "b");
    const endPosition = blockPosition(doc, "c");
    const snapshot = createSideMenuDragSelectionSnapshot({
      prosemirrorView: {
        state: editorState(
          MultipleNodeSelection.create(
            doc,
            startPosition.posBeforeNode,
            endPosition.posBeforeNode + endPosition.node.nodeSize,
          ),
        ),
        dispatch: () => {},
      },
    });

    expect(snapshot?.selectedBlockIds?.join(",")).toBe("b,c");
    expect(snapshot?.selectionFrom === undefined).toBe(true);
    expect(snapshot?.selectionTo === undefined).toBe(true);
  });

  test("snapshots a node selection as one block id", () => {
    const doc = pmDoc();
    const position = blockPosition(doc, "b");
    const snapshot = createSideMenuDragSelectionSnapshot({
      prosemirrorView: {
        state: editorState(NodeSelection.create(doc, position.posBeforeNode)),
        dispatch: () => {},
      },
    });

    expect(snapshot?.selectedBlockIds?.join(",")).toBe("b");
  });

  test("does not snapshot a collapsed text selection", () => {
    const doc = pmDoc();
    const position = blockPosition(doc, "b");
    const cursor = position.posBeforeNode + 1;
    const snapshot = createSideMenuDragSelectionSnapshot({
      prosemirrorView: {
        state: editorState(TextSelection.create(doc, cursor, cursor)),
        dispatch: () => {},
      },
    });

    expect(snapshot === null).toBe(true);
  });

  test("deduplicates repeated descendants while expanding block children", () => {
    const sharedChild = block("shared");

    expect(
      expandSideMenuSelectionBlocksWithChildren([block("parent", [sharedChild]), sharedChild])
        .map((entry) => entry.id)
        .join(","),
    ).toBe("parent,shared");
  });

  test("applies block-level selection with the complete intent scope", () => {
    const calls: string[] = [];
    const applied = applySideMenuSelectionIntent(
      {
        getSelection: () => undefined,
      },
      {
        clickedBlock: block("b"),
        blocks: [block("a"), block("b"), block("c")],
        source: "active-selection",
      },
      {
        selectBlocks: (_editor, blocks, fallbackBlock) => {
          calls.push(`${blocks.map((entry) => entry.id).join(":")}|${fallbackBlock.id}`);
          return true;
        },
      },
    );

    expect(applied).toBe(true);
    expect(calls.join(",")).toBe("a:b:c|b");
  });

  test("uses a block-range selection for a single clicked block", () => {
    const state = EditorState.create({ schema: pmSchema, doc: pmDoc() });
    let appliedSelection: unknown;

    const applied = applySideMenuSelectionIntent(
      {
        getSelection: () => undefined,
        prosemirrorView: {
          state,
          dispatch: (transaction) => {
            appliedSelection = transaction.selection;
          },
        },
      },
      {
        clickedBlock: block("b"),
        blocks: [block("b")],
        source: "clicked-block",
      },
    );

    expect(applied).toBe(true);
    expect(appliedSelection instanceof MultipleNodeSelection).toBe(true);
    expect((appliedSelection as MultipleNodeSelection).visible).toBe(false);
  });

  test("reports adapter failure without throwing", () => {
    const calls: string[] = [];
    const applied = applySideMenuSelectionIntent(
      {
        getSelection: () => undefined,
      },
      {
        clickedBlock: block("b"),
        blocks: [block("a"), block("b")],
        source: "active-selection",
      },
      {
        selectBlocks: () => {
          calls.push("failed");
          return false;
        },
      },
    );

    expect(applied).toBe(false);
    expect(calls.join(",")).toBe("failed");
  });
});
