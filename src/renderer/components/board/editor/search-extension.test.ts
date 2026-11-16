import { describe, expect, test } from "vite-plus/test";
import { Schema } from "@tiptap/pm/model";
import {
  escapeAttributeValue,
  findNfmSearchMatches,
  getCollapsedToggleAncestorIds,
} from "./search-extension";

function makeBlockElement(collapsed: boolean): HTMLElement {
  const toggleWrapper = {
    getAttribute: (name: string) =>
      name === "data-show-children" ? (collapsed ? "false" : "true") : null,
  } as unknown as HTMLElement;
  const outer = {
    querySelector: (selector: string) => (selector === ".bn-toggle-wrapper" ? toggleWrapper : null),
  } as unknown as HTMLElement;
  return {
    closest: (selector: string) => (selector === ".bn-block-outer" ? outer : null),
  } as unknown as HTMLElement;
}

describe("search extension helpers", () => {
  test("finds one occurrence across a bold boundary and stops at line and inline atom boundaries", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "inline*" },
        text: { group: "inline" },
        break: { inline: true, group: "inline" },
      },
      marks: { bold: {} },
    });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("😀 İｍｉ"),
        schema.text("grá", [schema.mark("bold")]),
        schema.text("tion mi"),
        schema.node("break"),
        schema.text("gration mi"),
      ]),
      schema.node("paragraph", null, schema.text("gration")),
    ]);

    const matches = findNfmSearchMatches(doc, "MIGRATION");
    expect(matches).toEqual([{ from: 5, to: 14 }]);
    expect(findNfmSearchMatches(doc, "migartion")).toEqual([]);
    expect(doc.textBetween(matches[0]!.from, matches[0]!.to)).toBe("ｍｉgrátion");
  });

  test("escapeAttributeValue returns a selector-safe string", () => {
    const escaped = escapeAttributeValue('a"b\\c');
    expect(typeof escaped).toBe("string");
    expect(escaped.includes("a")).toBe(true);
    expect(escaped.includes("b")).toBe(true);
  });

  test("getCollapsedToggleAncestorIds returns only collapsed ancestors root-first", () => {
    const blockBySelector = new Map<string, HTMLElement>([
      ['.bn-block[data-id="parent"]', makeBlockElement(true)],
      ['.bn-block[data-id="root"]', makeBlockElement(true)],
      ['.bn-block[data-id="open-parent"]', makeBlockElement(false)],
    ]);

    const editorDom = {
      querySelector: (selector: string) => blockBySelector.get(selector) ?? null,
    } as unknown as ParentNode;

    const parentById = new Map<string, { id: string }>([
      ["child", { id: "parent" }],
      ["parent", { id: "open-parent" }],
      ["open-parent", { id: "root" }],
    ]);

    const result = getCollapsedToggleAncestorIds(editorDom, "child", (id) => parentById.get(id));

    expect(JSON.stringify(result)).toBe(JSON.stringify(["root", "parent"]));
  });
});
