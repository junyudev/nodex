import { describe, expect, test } from "bun:test";
import { findToggleButtonForBlock, toggleCurrentToggleBlock } from "./toggle-shortcut";

describe("toggle shortcut", () => {
  test("findToggleButtonForBlock finds the current block toggle button", () => {
    const expectedSelector = '.bn-block[data-id="abc1234"] .bn-toggle-button';
    const button = { click: () => {} } as HTMLButtonElement;
    const root = {
      querySelector: (selector: string) => (
        selector === expectedSelector ? button : null
      ),
    } as unknown as ParentNode;

    const found = findToggleButtonForBlock(root, "abc1234");
    expect(found).toBe(button);
  });

  test("toggleCurrentToggleBlock clicks button for toggle blocks", () => {
    let clicked = false;
    const expectedSelector = '.bn-block[data-id="toggle-1"] .bn-toggle-button';
    const button = {
      click: () => {
        clicked = true;
      },
    } as HTMLButtonElement;
    const root = {
      querySelector: (selector: string) => (
        selector === expectedSelector ? button : null
      ),
    } as unknown as ParentNode;

    const didToggle = toggleCurrentToggleBlock({
      domElement: root,
      getTextCursorPosition: () => ({
        block: { id: "toggle-1", type: "toggleListItem" },
      }),
    });

    expect(didToggle).toBeTrue();
    expect(clicked).toBeTrue();
  });

  test("toggleCurrentToggleBlock returns false for non-toggle blocks", () => {
    const root = {
      querySelector: () => null,
    } as unknown as ParentNode;

    const didToggle = toggleCurrentToggleBlock({
      domElement: root,
      getTextCursorPosition: () => ({
        block: { id: "paragraph-1", type: "paragraph" },
      }),
    });

    expect(didToggle).toBeFalse();
  });
});
