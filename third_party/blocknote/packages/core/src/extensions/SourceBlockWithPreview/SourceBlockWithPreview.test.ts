import { Schema, type Node } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import { describe, expect, test } from "vite-plus/test";

import { selectionIncludesBlock } from "./SourceBlockWithPreview.js";

const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer*" },
    blockContainer: {
      attrs: { id: {} },
      content: "blockContent",
      group: "bnBlock",
    },
    atomicBlock: { atom: true, group: "blockContent" },
    paragraph: { content: "inline*", group: "blockContent" },
    inlineAtom: { atom: true, inline: true, group: "inline" },
    text: { group: "inline" },
  },
  marks: {},
});

const fixtureDoc = (): Node =>
  schema.node("doc", null, [
    schema.node("blockGroup", null, [
      schema.node("blockContainer", { id: "atomic" }, [schema.node("atomicBlock")]),
      schema.node("blockContainer", { id: "inline" }, [
        schema.node("paragraph", null, [schema.text("a"), schema.node("inlineAtom")]),
      ]),
    ]),
  ]);

const positionOf = (doc: Node, nodeType: string): number => {
  let result: number | undefined;
  doc.descendants((node, pos) => {
    if (node.type.name !== nodeType) return true;
    result = pos;
    return false;
  });
  if (result === undefined) throw new Error(`Missing ${nodeType} fixture node`);
  return result;
};

describe("source Block selection", () => {
  test("recognizes a selected atomic content node as its owning Block", () => {
    const doc = fixtureDoc();
    const selection = NodeSelection.create(doc, positionOf(doc, "atomicBlock"));

    expect(selectionIncludesBlock(selection, "atomic")).toBe(true);
  });

  test("does not promote an inline atom to the whole source Block", () => {
    const doc = fixtureDoc();
    const selection = NodeSelection.create(doc, positionOf(doc, "inlineAtom"));

    expect(selectionIncludesBlock(selection, "inline")).toBe(false);
  });
});
