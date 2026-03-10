import { describe, expect, test } from "bun:test";
import {
  findInlineContentForBlock,
  selectCurrentBlockContent,
} from "./select-block-shortcut";

describe("select block shortcut", () => {
  test("findInlineContentForBlock locates inline content for current block", () => {
    const expectedSelector = '.bn-block[data-id="abc1234"] .bn-inline-content';
    const inlineContent = {
      ownerDocument: { createRange: () => ({ selectNodeContents: () => {} }) },
    } as unknown as HTMLElement;
    const root = {
      querySelector: (selector: string) =>
        selector === expectedSelector ? inlineContent : null,
    } as unknown as ParentNode;

    const found = findInlineContentForBlock(root, "abc1234");
    expect(found).toBe(inlineContent);
  });

  test("selectCurrentBlockContent selects only inline content for inline blocks", () => {
    let removedRanges = false;
    let addedRange: unknown = null;
    let selectedNode: unknown = null;

    const range = {
      selectNodeContents: (node: Node) => {
        selectedNode = node;
      },
    } as unknown as Range;
    const inlineContent = {
      ownerDocument: { createRange: () => range },
    } as unknown as HTMLElement;
    const root = {
      querySelector: (selector: string) =>
        selector === '.bn-block[data-id="toggle-1"] .bn-inline-content'
          ? inlineContent
          : null,
    } as unknown as ParentNode;
    const selection = {
      removeAllRanges: () => {
        removedRanges = true;
      },
      addRange: (nextRange: Range) => {
        addedRange = nextRange;
      },
    } as unknown as Selection;

    const didSelect = selectCurrentBlockContent(
      {
        domElement: root,
        schema: {
          blockSchema: {
            toggleListItem: { content: "inline" },
          },
        },
        getTextCursorPosition: () => ({
          block: { id: "toggle-1", type: "toggleListItem" },
        }),
      },
      selection,
    );

    expect(didSelect).toBeTrue();
    expect(removedRanges).toBeTrue();
    expect(addedRange).toBe(range);
    expect(selectedNode).toBe(inlineContent);
  });

  test("selectCurrentBlockContent returns false for non-inline blocks", () => {
    const selection = {
      removeAllRanges: () => {},
      addRange: () => {},
    } as unknown as Selection;
    const didSelect = selectCurrentBlockContent(
      {
        domElement: undefined,
        schema: {
          blockSchema: {
            divider: { content: "none" },
          },
        },
        getTextCursorPosition: () => ({
          block: { id: "divider-1", type: "divider" },
        }),
      },
      selection,
    );

    expect(didSelect).toBeFalse();
  });
});
