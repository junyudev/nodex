import { describe, expect, test } from "vite-plus/test";
import { isBlockLevelSelection, shouldUseTextActionMenu } from "./nfm-text-action-menu-model";

describe("markdown text action menu model", () => {
  test("uses the Notion-style menu only for editable expanded rich-text selections", () => {
    expect(
      shouldUseTextActionMenu({
        isEditable: true,
        isTableCellSelection: false,
        hasInlineContent: true,
        selectedTextLength: 5,
        selectionFrom: 3,
        selectionTo: 8,
      }),
    ).toBe(true);

    expect(
      shouldUseTextActionMenu({
        isEditable: true,
        isTableCellSelection: false,
        hasInlineContent: true,
        selectedTextLength: 0,
        selectionFrom: 3,
        selectionTo: 3,
      }),
    ).toBe(false);

    expect(
      shouldUseTextActionMenu({
        isEditable: true,
        isTableCellSelection: false,
        hasInlineContent: true,
        selectedTextLength: 0,
        selectionFrom: 3,
        selectionTo: 8,
      }),
    ).toBe(false);

    expect(
      shouldUseTextActionMenu({
        isEditable: true,
        isTableCellSelection: true,
        hasInlineContent: true,
        selectedTextLength: 5,
        selectionFrom: 3,
        selectionTo: 8,
      }),
    ).toBe(false);

    expect(
      shouldUseTextActionMenu({
        isEditable: true,
        isTableCellSelection: false,
        isBlockSelection: true,
        hasInlineContent: true,
        selectedTextLength: 5,
        selectionFrom: 3,
        selectionTo: 8,
      }),
    ).toBe(false);
  });

  test("recognizes ProseMirror block-level selections", () => {
    expect(isBlockLevelSelection({ node: { attrs: { id: "single" } } })).toBe(true);
    expect(isBlockLevelSelection({ nodes: [{ attrs: { id: "a" } }] })).toBe(true);
    expect(isBlockLevelSelection({ from: 1, to: 2 })).toBe(false);
  });
});
