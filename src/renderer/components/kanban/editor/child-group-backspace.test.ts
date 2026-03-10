import { describe, expect, test } from "bun:test";
import {
  handleChildGroupBackspace,
  type EditorForChildGroupBackspace,
} from "./child-group-backspace";

function makeEditor(
  overrides: Partial<EditorForChildGroupBackspace> & {
    blockId?: string;
    blockHasChildren?: boolean;
    currentType?: string;
    currentProps?: Record<string, unknown>;
    hasParent?: boolean;
    hasPreviousSibling?: boolean;
    hasNextSibling?: boolean;
    parentType?: string;
    parentProps?: Record<string, unknown>;
    parentInline?: boolean;
    selectionEmpty?: boolean;
    atBlockStart?: boolean;
    currentContent?: unknown;
    targetContent?: unknown;
  } = {},
) {
  const {
    blockId = "child-1",
    blockHasChildren = false,
    currentType = "paragraph",
    currentProps = {},
    hasParent = true,
    hasPreviousSibling = true,
    hasNextSibling = false,
    parentType = "paragraph",
    parentProps = {},
    parentInline = true,
    selectionEmpty = true,
    atBlockStart = true,
    currentContent = [],
    targetContent = ["Hello"],
  } = overrides;

  const parentId = "parent-1";
  const previousSiblingId = "child-0";
  const nextSiblingId = "child-2";
  let focused = false;
  let mergedTarget: string | undefined;
  let mergedSource: string | undefined;

  const parentChildren = [
    ...(hasPreviousSibling ? [{ id: previousSiblingId }] : []),
    { id: blockId },
    ...(hasNextSibling ? [{ id: nextSiblingId }] : []),
  ];

  const parentBlock = {
    id: parentId,
    type: parentType,
    props: parentProps,
    content: targetContent,
    children: parentChildren,
  };
  const currentBlock = {
    id: blockId,
    type: currentType,
    props: currentProps,
    content: currentContent,
    children: blockHasChildren ? [{ id: "grand-child-1" }] : [],
  };
  const previousSibling = {
    id: previousSiblingId,
    type: "paragraph",
    content: targetContent,
    children: [],
  };
  const nextSibling = {
    id: nextSiblingId,
    type: "paragraph",
    content: ["Next"],
    children: [],
  };

  const editor: EditorForChildGroupBackspace = {
    schema: {
      blockSchema: {
        paragraph: { content: "inline" },
        toggleListItem: { content: "inline" },
        cardToggle: { content: "inline" },
        image: { content: "none" },
        quote: { content: "inline" },
        bulletListItem: { content: "inline" },
        numberedListItem: { content: "inline" },
        checkListItem: { content: "inline" },
        heading: { content: "inline" },
        [currentType]: { content: "inline" },
        [parentType]: { content: parentInline ? "inline" : "none" },
      },
    },
    getTextCursorPosition: () => ({
      block: { id: blockId, type: currentType },
    }),
    getBlock: (id: string) => {
      if (id === blockId) return currentBlock;
      if (id === parentId) return parentBlock;
      if (id === previousSiblingId) return previousSibling;
      if (id === nextSiblingId) return nextSibling;
      return undefined;
    },
    getParentBlock: (id: string) =>
      hasParent && id === blockId ? parentBlock : undefined,
    getPrevBlock: (id: string) =>
      hasPreviousSibling && id === blockId ? previousSibling : undefined,
    mergeIntoBlock: (targetId: string, sourceId: string) => {
      mergedTarget = targetId;
      mergedSource = sourceId;
    },
    focus: () => {
      focused = true;
    },
    transact: ((fn: (...args: unknown[]) => unknown) => {
      if (fn.length > 0) {
        const anchor = atBlockStart ? 0 : 3;
        const head = selectionEmpty ? anchor : anchor + 2;
        return fn({
          selection: {
            anchor,
            head,
            $anchor: {
              parentOffset: atBlockStart ? 0 : 3,
              parent: { content: { size: 8 } },
            },
          },
        });
      }
      return fn();
    }) as EditorForChildGroupBackspace["transact"],
    ...overrides,
  };

  return Object.assign(editor, {
    _focused: () => focused,
    _mergedTarget: () => mergedTarget,
    _mergedSource: () => mergedSource,
  });
}

describe("handleChildGroupBackspace", () => {
  test("merges child into previous sibling for non-toggle inline parent", () => {
    const editor = makeEditor({
      parentType: "paragraph",
      parentInline: true,
      currentContent: [" World"],
      targetContent: ["Hello"],
    });

    const handled = handleChildGroupBackspace(editor);

    expect(handled).toBeTrue();
    expect(editor._mergedTarget()).toBe("child-0");
    expect(editor._mergedSource()).toBe("child-1");
    expect(editor._focused()).toBeTrue();
  });

  test("merges first child into parent when no previous sibling", () => {
    const editor = makeEditor({
      parentType: "paragraph",
      parentInline: true,
      hasPreviousSibling: false,
      currentContent: [" trailing"],
      targetContent: ["Title"],
    });

    const handled = handleChildGroupBackspace(editor);

    expect(handled).toBeTrue();
    expect(editor._mergedTarget()).toBe("parent-1");
    expect(editor._mergedSource()).toBe("child-1");
  });

  test("merges first child into toggle-list parent", () => {
    const editor = makeEditor({
      parentType: "toggleListItem",
      parentInline: true,
      hasPreviousSibling: false,
      currentContent: ["childA"],
      targetContent: ["1111"],
    });

    expect(handleChildGroupBackspace(editor)).toBeTrue();
    expect(editor._mergedTarget()).toBe("parent-1");
    expect(editor._mergedSource()).toBe("child-1");
  });

  test("merges first child into toggle-list parent when next sibling exists", () => {
    const editor = makeEditor({
      parentType: "toggleListItem",
      parentInline: true,
      hasPreviousSibling: false,
      hasNextSibling: true,
      currentContent: ["childA"],
      targetContent: ["1111"],
    });

    expect(handleChildGroupBackspace(editor)).toBeTrue();
    expect(editor._mergedTarget()).toBe("parent-1");
    expect(editor._mergedSource()).toBe("child-1");
  });

  test("merges middle toggle child into previous sibling when next sibling exists", () => {
    const editor = makeEditor({
      parentType: "toggleListItem",
      parentInline: true,
      hasPreviousSibling: true,
      hasNextSibling: true,
      currentContent: ["childB"],
      targetContent: ["childA"],
    });

    expect(handleChildGroupBackspace(editor)).toBeTrue();
    expect(editor._mergedTarget()).toBe("child-0");
    expect(editor._mergedSource()).toBe("child-1");
  });

  test("merges tail toggle child into previous sibling", () => {
    const editor = makeEditor({
      parentType: "toggleListItem",
      parentInline: true,
      hasPreviousSibling: true,
      hasNextSibling: false,
      currentContent: ["childB"],
      targetContent: ["childA"],
    });

    expect(handleChildGroupBackspace(editor)).toBeTrue();
    expect(editor._mergedTarget()).toBe("child-0");
    expect(editor._mergedSource()).toBe("child-1");
  });

  test("merges first child into quote parent", () => {
    const editor = makeEditor({
      parentType: "quote",
      parentInline: true,
      hasPreviousSibling: false,
      currentContent: ["quote child"],
      targetContent: ["quote parent"],
    });

    expect(handleChildGroupBackspace(editor)).toBeTrue();
    expect(editor._mergedTarget()).toBe("parent-1");
    expect(editor._mergedSource()).toBe("child-1");
  });

  test("merges first child into bullet-list parent", () => {
    const editor = makeEditor({
      parentType: "bulletListItem",
      parentInline: true,
      hasPreviousSibling: false,
      currentContent: ["bullet child"],
      targetContent: ["bullet parent"],
    });

    expect(handleChildGroupBackspace(editor)).toBeTrue();
    expect(editor._mergedTarget()).toBe("parent-1");
    expect(editor._mergedSource()).toBe("child-1");
  });

  test("merges first child into toggle heading parent", () => {
    const editor = makeEditor({
      parentType: "heading",
      parentInline: true,
      parentProps: { isToggleable: true },
      hasPreviousSibling: false,
      currentContent: ["heading child"],
      targetContent: ["heading parent"],
    });

    expect(handleChildGroupBackspace(editor)).toBeTrue();
    expect(editor._mergedTarget()).toBe("parent-1");
    expect(editor._mergedSource()).toBe("child-1");
  });

  test("returns false when parent is not inline", () => {
    const editor = makeEditor({
      parentType: "image",
      parentInline: false,
    });

    expect(handleChildGroupBackspace(editor)).toBeFalse();
    expect(editor._mergedTarget()).toBe(undefined);
  });

  test("returns false when target content is not an inline array", () => {
    const editor = makeEditor({
      targetContent: { invalid: true },
    });

    expect(handleChildGroupBackspace(editor)).toBeFalse();
    expect(editor._mergedTarget()).toBe(undefined);
  });

  test("returns false when current content is not an inline array", () => {
    const editor = makeEditor({
      currentContent: "invalid",
    });

    expect(handleChildGroupBackspace(editor)).toBeFalse();
  });

  test("returns false when block has children", () => {
    const editor = makeEditor({ blockHasChildren: true });
    expect(handleChildGroupBackspace(editor)).toBeFalse();
  });

  test("returns false when selection is a range", () => {
    const editor = makeEditor({ selectionEmpty: false });
    expect(handleChildGroupBackspace(editor)).toBeFalse();
  });

  test("returns false when cursor is not at block start", () => {
    const editor = makeEditor({ atBlockStart: false });
    expect(handleChildGroupBackspace(editor)).toBeFalse();
  });

  test("returns false when parent does not exist", () => {
    const editor = makeEditor({ hasParent: false });
    expect(handleChildGroupBackspace(editor)).toBeFalse();
  });
});
