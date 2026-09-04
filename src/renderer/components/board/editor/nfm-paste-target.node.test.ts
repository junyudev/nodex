import { describe, expect, test } from "vite-plus/test";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import {
  captureNfmPasteTarget,
  clearNfmPasteTargets,
  createNfmPasteTargetPlugin,
} from "./nfm-paste-target";

const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer+" },
    blockContainer: { group: "bnBlock", attrs: { id: { default: null } }, content: "paragraph" },
    paragraph: { content: "text*" },
    text: {},
  },
});
const block = (id: string, text: string) =>
  schema.node("blockContainer", { id }, schema.node("paragraph", null, schema.text(text)));
const makeView = () => {
  const doc = schema.node(
    "doc",
    null,
    schema.node("blockGroup", null, [block("a", "hello"), block("b", "world")]),
  );
  let state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, 4, 6),
    plugins: [createNfmPasteTargetPlugin()],
  });
  return {
    isDestroyed: false,
    get state() {
      return state;
    },
    dispatch: (tr: Transaction) => {
      state = state.apply(tr);
    },
  };
};

describe("asynchronous paste targets", () => {
  test("unmounted editors have no usable paste target", () => {
    expect(captureNfmPasteTarget(undefined).restore()).toBe(false);
    expect(() => clearNfmPasteTargets(undefined)).not.toThrow();
  });
  test("maps the original range through edits without following a moved caret", () => {
    const view = makeView();
    const pending = captureNfmPasteTarget(view);
    view.dispatch(view.state.tr.insertText("prefix", 3));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 19)));
    expect(pending.restore()).toBe(true);
    expect(pending.restore()).toBe(false);
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(
      "el",
    );
    view.dispatch(view.state.tr.insertText("PASTE"));
    expect(view.state.doc.textContent).toBe("prefixhPASTEloworld");
    pending.release();
    expect(pending.restore()).toBe(false);
  });
  test("refuses a deleted target even when another block can accept text", () => {
    const view = makeView();
    const pending = captureNfmPasteTarget(view);
    view.dispatch(view.state.tr.delete(1, 1 + view.state.doc.child(0).child(0).nodeSize));
    expect(pending.restore()).toBe(false);
    expect(view.state.doc.textContent).toBe("world");
  });
  test("invalidates pending operations when a retained view closes", () => {
    const view = makeView();
    const pending = captureNfmPasteTarget(view);
    clearNfmPasteTargets(view);
    expect(pending.restore()).toBe(false);
    const next = captureNfmPasteTarget(view);
    view.isDestroyed = true;
    expect(next.restore()).toBe(false);
    next.release();
  });
});
