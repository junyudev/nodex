import { expect, test, vi } from "vite-plus/test";
import { Schema } from "@tiptap/pm/model";
import { TextSelection, NodeSelection } from "@tiptap/pm/state";
import {
  createPageEditorSelectionObservation,
  readPageEditorSelectedBlockIds,
} from "./page-editor-selection";

const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer*" },
    blockContainer: { attrs: { id: {} }, content: "paragraph", group: "bnBlock" },
    paragraph: { content: "text*", group: "blockContent" },
    text: {},
  },
});
const doc = schema.node("doc", null, [
  schema.node("blockGroup", null, [
    schema.node("blockContainer", { id: "a" }, [
      schema.node("paragraph", null, schema.text("hello")),
    ]),
  ]),
]);

test("a caret contributes no Block even if the editor reports a current Block", () => {
  expect(
    readPageEditorSelectedBlockIds({
      prosemirrorView: { state: { selection: TextSelection.create(doc, 3) } } as never,
      getSelection: () => ({ blocks: [{ id: "a" }] }),
    }),
  ).toEqual([]);
  expect(
    readPageEditorSelectedBlockIds({
      prosemirrorView: { state: { selection: TextSelection.create(doc, 3, 5) } } as never,
      getSelection: () => ({ blocks: [{ id: "a", children: [{ id: "child" }] }, { id: "child" }] }),
    }),
  ).toEqual(["a"]);
  expect(
    readPageEditorSelectedBlockIds({
      prosemirrorView: { state: { selection: NodeSelection.create(doc, 1) } } as never,
    }),
  ).toEqual(["a"]);
});

test("focus leaving the Page retains selection; a focused caret explicitly clears it", () => {
  let ids: readonly string[] = ["a"];
  let focused = true;
  const source = createPageEditorSelectionObservation({ read: () => ids, focused: () => focused });
  const notify = vi.fn();
  const release = source.subscribeSelection(notify);
  const first = source.readSelection();
  source.update();
  expect(source.readSelection()).toBe(first);
  expect(notify).not.toHaveBeenCalled();
  focused = false;
  ids = [];
  source.update();
  expect(source.readSelection()).toEqual(["a"]);
  focused = true;
  source.update();
  expect(source.readSelection()).toEqual([]);
  expect(notify).toHaveBeenCalledTimes(1);
  release();
});

test("a selection handed to a chat is released even after focus leaves the Page", () => {
  let ids: readonly string[] = ["a"];
  const source = createPageEditorSelectionObservation({ read: () => ids, focused: () => false });
  const notify = vi.fn();
  const unsubscribe = source.subscribeSelection(notify);
  // The Composer took focus, so the collapsed caret alone would keep the old selection.
  ids = [];
  source.update();
  expect(source.readSelection()).toEqual(["a"]);
  source.release();
  expect(source.readSelection()).toEqual([]);
  source.release();
  expect(notify).toHaveBeenCalledTimes(1);
  unsubscribe();
});
