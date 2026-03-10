import { describe, expect, test } from "bun:test";
import {
  handleChildGroupEmptyEnter,
  handleParentEnterSplitToFirstChild,
  handleToggleEnterToChild,
  isToggleOpenInDom,
  type EditorForChildGroupEnter,
} from "./child-group-enter";

// CSS.escape is not available in Bun's test environment.
if (typeof globalThis.CSS === "undefined") {
  (globalThis as unknown as { CSS: { escape: (v: string) => string } }).CSS = {
    escape: (v: string) => v,
  };
}

function makeDom(
  blockId: string,
  showChildren: string,
): ParentNode {
  const sel = `.bn-block[data-id="${blockId}"] .bn-toggle-wrapper`;
  return {
    querySelector: (s: string) =>
      s === sel
        ? ({ getAttribute: (a: string) => (a === "data-show-children" ? showChildren : null) } as unknown as Element)
        : null,
  } as unknown as ParentNode;
}

function makeParentEditor(
  overrides: Partial<EditorForChildGroupEnter> & {
    blockId?: string;
    blockType?: string;
    blockInline?: boolean;
    childCount?: number;
    parentOffset?: number;
    contentSize?: number;
    selectionEmpty?: boolean;
  } = {},
) {
  const {
    blockId = "parent-1",
    blockType = "paragraph",
    blockInline = true,
    childCount = 2,
    parentOffset = 3,
    contentSize = 6,
    selectionEmpty = true,
  } = overrides;

  let focused = false;
  let splitParentId: string | undefined;

  const parentBlock = {
    id: blockId,
    type: blockType,
    props: {},
    content: ["hello"],
    children: Array.from({ length: childCount }, (_, i) => ({ id: `child-${i}` })),
  };

  const editor: EditorForChildGroupEnter = {
    schema: {
      blockSchema: {
        paragraph: { content: "inline" },
        heading: { content: "inline" },
        toggleListItem: { content: "inline" },
        cardToggle: { content: "inline" },
        image: { content: "none" },
        [blockType]: { content: blockInline ? "inline" : "none" },
      },
    },
    domElement: makeDom(blockId, "true"),
    getTextCursorPosition: () => ({
      block: { id: blockId, type: blockType },
    }),
    getBlock: (id: string) => (id === blockId ? parentBlock : undefined),
    getParentBlock: () => undefined,
    insertBlocks: () => [],
    updateBlock: () => parentBlock,
    setTextCursorPosition: () => {},
    focus: () => {
      focused = true;
    },
    splitParentIntoFirstChild: (id: string) => {
      splitParentId = id;
      return true;
    },
    transact: ((fn: (...args: unknown[]) => unknown) => {
      if (fn.length > 0) {
        const anchor = parentOffset;
        const head = selectionEmpty ? anchor : anchor + 2;
        return fn({
          selection: {
            anchor,
            head,
            $anchor: {
              parentOffset,
              parent: { content: { size: contentSize } },
            },
          },
        });
      }
      return fn();
    }) as EditorForChildGroupEnter["transact"],
    ...overrides,
  };

  return Object.assign(editor, {
    _focused: () => focused,
    _splitParentId: () => splitParentId,
  });
}

function makeChildEditor(
  overrides: Partial<EditorForChildGroupEnter> & {
    blockId?: string;
    blockHasChildren?: boolean;
    hasParent?: boolean;
    parentType?: string;
    parentInline?: boolean;
    selectionEmpty?: boolean;
    contentSize?: number;
  } = {},
) {
  const {
    blockId = "child-1",
    blockHasChildren = false,
    hasParent = true,
    parentType = "paragraph",
    parentInline = true,
    selectionEmpty = true,
    contentSize = 0,
  } = overrides;

  const parentId = "parent-1";
  let focused = false;
  let insertedAfter: string | undefined;
  let cursorTarget: string | undefined;

  const currentBlock = {
    id: blockId,
    type: "paragraph",
    props: {},
    content: [],
    children: blockHasChildren ? [{ id: "grand-child-1" }] : [],
  };
  const parentBlock = {
    id: parentId,
    type: parentType,
    props: {},
    content: ["title"],
    children: [{ id: blockId }],
  };

  const editor: EditorForChildGroupEnter = {
    schema: {
      blockSchema: {
        paragraph: { content: "inline" },
        heading: { content: "inline" },
        toggleListItem: { content: "inline" },
        cardToggle: { content: "inline" },
        image: { content: "none" },
        [parentType]: { content: parentInline ? "inline" : "none" },
      },
    },
    domElement: undefined,
    getTextCursorPosition: () => ({
      block: { id: blockId, type: "paragraph" },
    }),
    getBlock: (id: string) => {
      if (id === blockId) return currentBlock;
      if (id === parentId) return parentBlock;
      return undefined;
    },
    getParentBlock: (id: string) =>
      hasParent && id === blockId ? parentBlock : undefined,
    insertBlocks: (_blocks, refId) => {
      insertedAfter = refId;
      return [{ id: "new-sibling-1" }];
    },
    updateBlock: () => parentBlock,
    setTextCursorPosition: (id: string) => {
      cursorTarget = id;
    },
    focus: () => {
      focused = true;
    },
    splitParentIntoFirstChild: () => true,
    transact: ((fn: (...args: unknown[]) => unknown) => {
      if (fn.length > 0) {
        const anchor = 0;
        const head = selectionEmpty ? anchor : anchor + 2;
        return fn({
          selection: {
            anchor,
            head,
            $anchor: {
              parentOffset: 0,
              parent: { content: { size: contentSize } },
            },
          },
        });
      }
      return fn();
    }) as EditorForChildGroupEnter["transact"],
    ...overrides,
  };

  return Object.assign(editor, {
    _focused: () => focused,
    _insertedAfter: () => insertedAfter,
    _cursorTarget: () => cursorTarget,
  });
}

function makeToggleFallbackEditor(
  overrides: Partial<EditorForChildGroupEnter> & {
    blockType?: string;
    blockId?: string;
    childCount?: number;
    showChildren?: string;
    parentOffset?: number;
    contentSize?: number;
    selectionEmpty?: boolean;
  } = {},
) {
  const {
    blockType = "toggleListItem",
    blockId = "toggle-1",
    childCount = 0,
    showChildren = "true",
    parentOffset = 5,
    contentSize = 5,
    selectionEmpty = true,
  } = overrides;

  let updatedBlock: { id: string; children: { id: string }[] } | undefined;
  let cursorTarget: string | undefined;
  let focused = false;

  const editor: EditorForChildGroupEnter = {
    schema: {
      blockSchema: {
        paragraph: { content: "inline" },
        toggleListItem: { content: "inline" },
        cardToggle: { content: "inline" },
        heading: { content: "inline" },
      },
    },
    domElement: makeDom(blockId, showChildren),
    getTextCursorPosition: () => ({
      block: { id: blockId, type: blockType },
    }),
    getBlock: (id: string) =>
      id === blockId
        ? {
            id: blockId,
            type: blockType,
            props: {},
            content: ["title"],
            children: Array.from({ length: childCount }, (_, i) => ({ id: `child-${i}` })),
          }
        : undefined,
    getParentBlock: () => undefined,
    insertBlocks: () => [],
    updateBlock: (_block, update) => {
      updatedBlock = {
        id: blockId,
        children: update.children.map((_, i) => ({ id: `new-child-${i}` })),
      };
      return {
        id: blockId,
        type: blockType,
        props: {},
        content: [],
        children: updatedBlock.children,
      };
    },
    setTextCursorPosition: (id: string) => {
      cursorTarget = id;
    },
    focus: () => {
      focused = true;
    },
    splitParentIntoFirstChild: () => true,
    transact: ((fn: (...args: unknown[]) => unknown) => {
      if (fn.length > 0) {
        const anchor = parentOffset;
        const head = selectionEmpty ? anchor : anchor + 3;
        return fn({
          selection: {
            anchor,
            head,
            $anchor: {
              parentOffset,
              parent: { content: { size: contentSize } },
            },
          },
        });
      }
      return fn();
    }) as EditorForChildGroupEnter["transact"],
    ...overrides,
  };

  return Object.assign(editor, {
    _cursorTarget: () => cursorTarget,
    _focused: () => focused,
    _updatedChildren: () => updatedBlock?.children,
  });
}

describe("isToggleOpenInDom", () => {
  test("returns true when data-show-children is true", () => {
    expect(isToggleOpenInDom(makeDom("t1", "true"), "t1")).toBeTrue();
  });

  test("returns false when data-show-children is false", () => {
    expect(isToggleOpenInDom(makeDom("t1", "false"), "t1")).toBeFalse();
  });

  test("returns false when dom is undefined", () => {
    expect(isToggleOpenInDom(undefined, "t1")).toBeFalse();
  });
});

describe("handleChildGroupEmptyEnter", () => {
  test("creates sibling after empty child for non-toggle inline parent", () => {
    const editor = makeChildEditor({ parentType: "paragraph", parentInline: true });

    const handled = handleChildGroupEmptyEnter(editor);

    expect(handled).toBeTrue();
    expect(editor._insertedAfter()).toBe("child-1");
    expect(editor._cursorTarget()).toBe("new-sibling-1");
    expect(editor._focused()).toBeTrue();
  });

  test("supports toggle-like inline parent blocks", () => {
    const editor = makeChildEditor({ parentType: "toggleListItem", parentInline: true });
    expect(handleChildGroupEmptyEnter(editor)).toBeTrue();
  });

  test("returns false when parent is not inline", () => {
    const editor = makeChildEditor({ parentType: "image", parentInline: false });
    expect(handleChildGroupEmptyEnter(editor)).toBeFalse();
  });

  test("returns false when child is not empty", () => {
    const editor = makeChildEditor({ contentSize: 3 });
    expect(handleChildGroupEmptyEnter(editor)).toBeFalse();
  });

  test("returns false when block has children", () => {
    const editor = makeChildEditor({ blockHasChildren: true });
    expect(handleChildGroupEmptyEnter(editor)).toBeFalse();
  });

  test("returns false when no parent exists", () => {
    const editor = makeChildEditor({ hasParent: false });
    expect(handleChildGroupEmptyEnter(editor)).toBeFalse();
  });

  test("returns false when selection is not empty", () => {
    const editor = makeChildEditor({ selectionEmpty: false });
    expect(handleChildGroupEmptyEnter(editor)).toBeFalse();
  });
});

describe("handleParentEnterSplitToFirstChild", () => {
  test("splits middle text into a new first child", () => {
    const editor = makeParentEditor({
      childCount: 2,
      parentOffset: 2,
      contentSize: 6,
    });

    const handled = handleParentEnterSplitToFirstChild(editor);

    expect(handled).toBeTrue();
    expect(editor._splitParentId()).toBe("parent-1");
    expect(editor._focused()).toBeTrue();
  });

  test("splits at end into an empty first child", () => {
    const editor = makeParentEditor({
      childCount: 2,
      parentOffset: 6,
      contentSize: 6,
    });

    expect(handleParentEnterSplitToFirstChild(editor)).toBeTrue();
    expect(editor._splitParentId()).toBe("parent-1");
  });

  test("returns false at start of title", () => {
    const editor = makeParentEditor({
      childCount: 2,
      parentOffset: 0,
      contentSize: 6,
    });

    expect(handleParentEnterSplitToFirstChild(editor)).toBeFalse();
  });

  test("returns false when selection is a range", () => {
    const editor = makeParentEditor({
      selectionEmpty: false,
      childCount: 2,
    });

    expect(handleParentEnterSplitToFirstChild(editor)).toBeFalse();
  });

  test("returns false when parent has no children", () => {
    const editor = makeParentEditor({
      childCount: 0,
    });

    expect(handleParentEnterSplitToFirstChild(editor)).toBeFalse();
  });

  test("returns false when parent is not inline", () => {
    const editor = makeParentEditor({
      blockType: "image",
      blockInline: false,
      childCount: 2,
    });

    expect(handleParentEnterSplitToFirstChild(editor)).toBeFalse();
  });
});

describe("handleToggleEnterToChild", () => {
  test("preserves toggle fallback: open no-children end creates first child", () => {
    const editor = makeToggleFallbackEditor({
      blockType: "toggleListItem",
      childCount: 0,
      showChildren: "true",
      parentOffset: 4,
      contentSize: 4,
    });

    const handled = handleToggleEnterToChild(editor);

    expect(handled).toBeTrue();
    expect(editor._cursorTarget()).toBe("new-child-0");
    expect(editor._focused()).toBeTrue();
    expect(editor._updatedChildren()?.length).toBe(1);
  });

  test("returns false for non-toggle blocks", () => {
    const editor = makeToggleFallbackEditor({ blockType: "paragraph" });
    expect(handleToggleEnterToChild(editor)).toBeFalse();
  });

  test("returns false when toggle is collapsed", () => {
    const editor = makeToggleFallbackEditor({ showChildren: "false" });
    expect(handleToggleEnterToChild(editor)).toBeFalse();
  });

  test("returns false when toggle already has children", () => {
    const editor = makeToggleFallbackEditor({ childCount: 1 });
    expect(handleToggleEnterToChild(editor)).toBeFalse();
  });

  test("returns false when cursor is not at end", () => {
    const editor = makeToggleFallbackEditor({ parentOffset: 2, contentSize: 4 });
    expect(handleToggleEnterToChild(editor)).toBeFalse();
  });

  test("returns false for range selection", () => {
    const editor = makeToggleFallbackEditor({ selectionEmpty: false });
    expect(handleToggleEnterToChild(editor)).toBeFalse();
  });
});
