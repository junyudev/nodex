import { Schema } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { expect, test } from "vite-plus/test";
import {
  captureSurfaceHistorySelection,
  resolveSurfaceHistorySelection,
} from "../../../../../third_party/blocknote/packages/core/src/yjs/extensions/semanticHistorySelection";

const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer+" },
    blockContainer: { attrs: { id: { default: null } }, content: "paragraph" },
    paragraph: { content: "inline*" },
    text: { group: "inline" },
    mention: { group: "inline", inline: true, atom: true },
  },
});
const block = (id: string, text: string) =>
  schema.node(
    "blockContainer",
    { id },
    schema.node("paragraph", null, text ? schema.text(text) : undefined),
  );
const state = (blocks: Parameters<typeof schema.node>[2]) =>
  EditorState.create({
    schema,
    doc: schema.node("doc", null, schema.node("blockGroup", null, blocks)),
  });

test("stable text anchors preserve backwards selections after Blocks are readdressed and reordered", () => {
  const before = state([block("a", "abc"), block("b", "def")]);
  const selected = before.apply(before.tr.setSelection(TextSelection.create(before.doc, 12, 4)));
  const bookmark = captureSurfaceHistorySelection(selected)!;
  const after = state([block("other", "unrelated"), block("a", "abc"), block("b", "def")]);
  const restored = resolveSurfaceHistorySelection(after, bookmark)!;
  expect(restored.$anchor.parent.textContent).toBe("def");
  expect(restored.$anchor.parentOffset).toBe(2);
  expect(restored.$head.parent.textContent).toBe("abc");
  expect(restored.$head.parentOffset).toBe(1);
  expect(restored.anchor).toBeGreaterThan(restored.head);
});

test("node bookmarks distinguish the outer Block, its content, and an inline atom", () => {
  const document = state([
    schema.node(
      "blockContainer",
      { id: "a" },
      schema.node("paragraph", null, [schema.text("a"), schema.node("mention"), schema.text("b")]),
    ),
  ]);
  for (const position of [1, 2, 4]) {
    const selection = NodeSelection.create(document.doc, position);
    const selected = document.apply(document.tr.setSelection(selection));
    const bookmark = captureSurfaceHistorySelection(selected)!;
    const restored = resolveSurfaceHistorySelection(document, bookmark)!;
    expect(restored).toBeInstanceOf(NodeSelection);
    expect(restored.from).toBe(position);
    expect((restored as NodeSelection).node.type.name).toBe(selection.node.type.name);
  }
});

test("missing identities never redirect selection to another Block and clamping stays inside its Block", () => {
  const before = state([block("a", "abcdef")]);
  const selected = before.apply(before.tr.setSelection(TextSelection.create(before.doc, 8)));
  const bookmark = captureSurfaceHistorySelection(selected)!;
  expect(
    resolveSurfaceHistorySelection(state([block("other", "abcdef")]), bookmark),
  ).toBeUndefined();
  const restored = resolveSurfaceHistorySelection(
    state([block("a", "x"), block("other", "abcdef")]),
    bookmark,
  )!;
  expect(restored.$head.parent.textContent).toBe("x");
  expect(restored.$head.parentOffset).toBe(1);
});
