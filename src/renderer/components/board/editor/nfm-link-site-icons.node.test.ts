import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { describe, expect, test } from "vite-plus/test";
import { createLinkSiteIconsPlugin, LinkSiteIconSlots } from "./nfm-link-site-icons";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
  marks: { link: { attrs: { href: {} }, inclusive: false, toDOM: () => ["a", 0] } },
});
const link = (href: string) => schema.marks.link!.create({ href });
const paragraph = (...parts: Array<string | [string, string]>) =>
  schema.nodes.paragraph!.create(
    null,
    parts.map((part) =>
      typeof part === "string" ? schema.text(part) : schema.text(part[0], [link(part[1])]),
    ),
  );

const plugin = createLinkSiteIconsPlugin(schema.marks.link!, new LinkSiteIconSlots());

function widgets(state: EditorState): Array<[number, string]> {
  const set = plugin.getState(state) as DecorationSet;
  return set
    .find()
    .map((decoration) => [decoration.from, String(decoration.spec.key)] as [number, string])
    .sort((a, b) => a[0] - b[0]);
}

/** What a full scan of the same document draws. */
function rescanned(doc: ProseMirrorNode) {
  return widgets(EditorState.create({ doc, plugins: [plugin] }));
}

describe("link site icons in the editor", () => {
  test("one icon per run of a web link, none for other links", () => {
    const state = EditorState.create({
      doc: schema.nodes.doc!.create(null, [
        paragraph("see ", ["docs", "https://docs.example.com"], " and ", [
          "page",
          "nodex://pages/x",
        ]),
        paragraph(
          ["a", "https://a.example"],
          ["b", "https://b.example"],
          ["c", "https://b.example"],
        ),
      ]),
      plugins: [plugin],
    });
    expect(widgets(state)).toEqual([
      [5, "link-site-icon:https://docs.example.com"],
      [20, "link-site-icon:https://a.example"],
      [21, "link-site-icon:https://b.example"],
    ]);
  });

  test("edits keep the icons a full scan would draw", () => {
    let state = EditorState.create({
      doc: schema.nodes.doc!.create(null, [
        paragraph("intro ", ["site", "https://one.example"], " tail"),
        paragraph("second"),
      ]),
      plugins: [plugin],
    });
    const edits: Array<(tr: Transaction) => Transaction> = [
      (tr) => tr.insertText("typed ", 1),
      (tr) => tr.addMark(20, 26, link("https://two.example")),
      (tr) => tr.insertText("x", 9),
      (tr) =>
        tr.removeMark(
          1,
          state.doc.content.size,
          schema.marks.link!.create({ href: "https://one.example" }),
        ),
      (tr) => tr.delete(2, 12),
      (tr) =>
        tr.replaceWith(
          state.doc.content.size,
          state.doc.content.size,
          paragraph("new ", ["three", "https://three.example"]),
        ),
    ];
    for (const edit of edits) {
      state = state.apply(edit(state.tr));
      expect(widgets(state)).toEqual(rescanned(state.doc));
    }
    expect(widgets(state).length).toBeGreaterThan(0);
  });
});
