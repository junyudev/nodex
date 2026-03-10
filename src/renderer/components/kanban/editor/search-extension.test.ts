import { describe, expect, test } from "bun:test";
import {
  escapeAttributeValue,
  getCollapsedToggleAncestorIds,
} from "./search-extension";

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
  test("escapeAttributeValue returns a selector-safe string", () => {
    const escaped = escapeAttributeValue('a"b\\c');
    expect(typeof escaped).toBe("string");
    expect(escaped.includes("a")).toBeTrue();
    expect(escaped.includes("b")).toBeTrue();
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

    const result = getCollapsedToggleAncestorIds(
      editorDom,
      "child",
      (id) => parentById.get(id),
    );

    expect(JSON.stringify(result)).toBe(JSON.stringify(["root", "parent"]));
  });
});
