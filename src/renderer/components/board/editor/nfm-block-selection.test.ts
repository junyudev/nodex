import { MultipleNodeSelection } from "@blocknote/core/extensions";
import { Schema, type Node } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { describe, expect, test } from "vite-plus/test";

import { getNfmBlockSelectionIds } from "./nfm-block-selection";

const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer*" },
    blockContainer: {
      attrs: { id: {} },
      content: "blockContent",
      group: "bnBlock",
    },
    paragraph: {
      content: "inline*",
      group: "blockContent",
    },
    atomicBlock: {
      atom: true,
      group: "blockContent",
    },
    inlineAtom: {
      atom: true,
      inline: true,
      group: "inline",
    },
    text: { group: "inline" },
  },
  marks: {},
});

function block(id: string, content: Node): Node {
  return schema.node("blockContainer", { id }, content);
}

function fixtureDoc(): Node {
  return schema.node("doc", null, [
    schema.node("blockGroup", null, [
      block("before", schema.node("paragraph", null, schema.text("before"))),
      block("atomic", schema.node("atomicBlock")),
      block(
        "inline",
        schema.node("paragraph", null, [
          schema.text("a"),
          schema.node("inlineAtom"),
          schema.text("b"),
        ]),
      ),
    ]),
  ]);
}

function nodePosition(doc: Node, predicate: (node: Node) => boolean): { node: Node; pos: number } {
  let match: { node: Node; pos: number } | undefined;
  doc.descendants((node, pos) => {
    if (!predicate(node)) return true;
    match = { node, pos };
    return false;
  });
  if (!match) throw new Error("Missing fixture node");
  return match;
}

describe("NFM Block selection identity", () => {
  test("resolves an outer Block node selection directly", () => {
    const doc = fixtureDoc();
    const atomic = nodePosition(doc, (node) => node.attrs.id === "atomic");

    expect(getNfmBlockSelectionIds(NodeSelection.create(doc, atomic.pos))).toEqual(["atomic"]);
  });

  test("maps a selected atomic Block content node to its owning Block", () => {
    const doc = fixtureDoc();
    const atomic = nodePosition(doc, (node) => node.attrs.id === "atomic");

    expect(getNfmBlockSelectionIds(NodeSelection.create(doc, atomic.pos + 1))).toEqual(["atomic"]);
  });

  test("preserves every outer Block in a multiple selection", () => {
    const doc = fixtureDoc();
    const before = nodePosition(doc, (node) => node.attrs.id === "before");
    const atomic = nodePosition(doc, (node) => node.attrs.id === "atomic");
    const selection = MultipleNodeSelection.create(
      doc,
      before.pos,
      atomic.pos + atomic.node.nodeSize,
    );

    expect(getNfmBlockSelectionIds(selection)).toEqual(["before", "atomic"]);
  });

  test("does not promote an inline atom to its owning Block", () => {
    const doc = fixtureDoc();
    const inlineAtom = nodePosition(doc, (node) => node.type.name === "inlineAtom");

    expect(getNfmBlockSelectionIds(NodeSelection.create(doc, inlineAtom.pos))).toEqual([]);
  });
});
