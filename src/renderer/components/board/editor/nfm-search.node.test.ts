import { describe, expect, test } from "vite-plus/test";
import { resolveFindShortcutSeedQuery } from "./find-shortcut-seed";
import { matchesNfmFindShortcut } from "./find-shortcut";
import { Schema } from "@tiptap/pm/model";
import {
  escapeAttributeValue,
  findNfmSearchMatches,
  getCollapsedToggleAncestorIds,
} from "./search-extension";

describe("resolveFindShortcutSeedQuery", () => {
  test("returns empty string when editor state is missing", () => {
    expect(resolveFindShortcutSeedQuery(undefined)).toBe("");
  });

  test("returns empty string when selection is collapsed", () => {
    const seed = resolveFindShortcutSeedQuery({
      prosemirrorState: {
        selection: { empty: true, from: 5, to: 5 },
        doc: { textBetween: () => "ignored" },
      },
    });

    expect(seed).toBe("");
  });

  test("returns trimmed selected text and uses spaces for block boundaries", () => {
    const calls: Array<[number, number, string | undefined]> = [];
    const seed = resolveFindShortcutSeedQuery({
      prosemirrorState: {
        selection: { empty: false, from: 3, to: 18 },
        doc: {
          textBetween: (from, to, blockSeparator) => {
            calls.push([from, to, blockSeparator]);
            return "  selected text  ";
          },
        },
      },
    });

    expect(seed).toBe("selected text");
    expect(JSON.stringify(calls)).toBe(JSON.stringify([[3, 18, " "]]));
  });
});

test.each(["macOS", "windows", "linux"] as const)(
  "local Find yields full-view and other modified F chords on %s",
  (platform) => {
    const event = {
      key: "f",
      code: "KeyF",
      metaKey: platform === "macOS",
      ctrlKey: platform !== "macOS",
      altKey: false,
      shiftKey: false,
    };
    expect(matchesNfmFindShortcut(event, platform)).toBe(true);
    expect(matchesNfmFindShortcut({ ...event, key: "F", shiftKey: true }, platform)).toBe(false);
    expect(matchesNfmFindShortcut({ ...event, altKey: true }, platform)).toBe(false);
    expect(matchesNfmFindShortcut({ ...event, key: "g", code: "KeyG" }, platform)).toBe(false);
  },
);

describe("search extension", () => {
  function makeBlockElement(collapsed: boolean): HTMLElement {
    const toggleWrapper = {
      getAttribute: (name: string) =>
        name === "data-show-children" ? (collapsed ? "false" : "true") : null,
    } as unknown as HTMLElement;
    const outer = {
      querySelector: (selector: string) =>
        selector === ".bn-toggle-wrapper" ? toggleWrapper : null,
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
});
