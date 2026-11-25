import { describe, expect, test } from "vite-plus/test";
import { planBackspaceAcrossAtomicBlocks } from "./atomic-block-backspace";
import {
  handleChildGroupBackspace,
  type EditorForChildGroupBackspace,
} from "./child-group-backspace";

describe("atomic block backspace", () => {
  interface TestBlock {
    readonly id: string;
    readonly type: string;
    readonly children: TestBlock[];
  }

  const block = (id: string, type = "paragraph"): TestBlock => ({ id, type, children: [] });

  function editorFor(input: {
    readonly blocks: TestBlock[];
    readonly cursorIndex: number;
    readonly atStart?: boolean;
    readonly parent?: TestBlock;
  }) {
    const current = input.blocks[input.cursorIndex]!;
    return {
      editor: {
        document: input.blocks,
        schema: {
          blockSchema: {
            paragraph: { content: "inline" },
            heading: { content: "inline" },
            codeBlock: { content: "plain" },
            mathBlock: { content: "plain" },
            page: { content: "none" },
            divider: { content: "none" },
            image: { content: "none" },
          },
        },
        prosemirrorView: {
          state: {
            selection: {
              empty: true,
              $from: { parentOffset: input.atStart === false ? 1 : 0 },
            },
          },
        },
        getTextCursorPosition: () => ({
          block: current,
          prevBlock: input.blocks[input.cursorIndex - 1],
        }),
        getParentBlock: () => input.parent,
      },
    };
  }

  describe("atomic Block Backspace", () => {
    test("plans a semantic merge across an owner, divider, and image run", () => {
      const input = editorFor({
        blocks: [
          block("before"),
          block("page", "page"),
          block("divider", "divider"),
          block("image", "image"),
          block("after"),
        ],
        cursorIndex: 4,
      });

      expect(planBackspaceAcrossAtomicBlocks(input.editor)).toEqual({
        kind: "merge",
        sourceBlockId: "after",
        targetBlockId: "before",
      });
    });

    test("claims the boundary when no earlier inline Block exists", () => {
      const input = editorFor({
        blocks: [block("page", "page"), block("after")],
        cursorIndex: 1,
      });

      expect(planBackspaceAcrossAtomicBlocks(input.editor)).toEqual({ kind: "protect_boundary" });
    });

    test("leaves ordinary merges and non-boundary Backspace to BlockNote", () => {
      const ordinary = editorFor({
        blocks: [block("before"), block("after")],
        cursorIndex: 1,
      });
      const middle = editorFor({
        blocks: [block("before"), block("page", "page"), block("after")],
        cursorIndex: 2,
        atStart: false,
      });

      expect(planBackspaceAcrossAtomicBlocks(ordinary.editor)).toBeNull();
      expect(planBackspaceAcrossAtomicBlocks(middle.editor)).toBeNull();
    });

    test("does not treat a plain-text Code Block as an atomic boundary", () => {
      const input = editorFor({
        blocks: [block("source", "codeBlock"), block("after")],
        cursorIndex: 1,
      });

      expect(planBackspaceAcrossAtomicBlocks(input.editor)).toBeNull();
    });

    test("can resolve a plain-text Code Block before an atomic run as the editable target", () => {
      const input = editorFor({
        blocks: [block("source", "codeBlock"), block("page", "page"), block("after")],
        cursorIndex: 2,
      });

      expect(planBackspaceAcrossAtomicBlocks(input.editor)).toEqual({
        kind: "merge",
        sourceBlockId: "after",
        targetBlockId: "source",
      });
    });

    test("treats preview-first Math source as atomic rather than a merge target", () => {
      const input = editorFor({
        blocks: [block("equation", "mathBlock"), block("after")],
        cursorIndex: 1,
      });

      expect(planBackspaceAcrossAtomicBlocks(input.editor)).toEqual({ kind: "protect_boundary" });
    });

    test("does not skip over preview-first Math to merge with an earlier text Block", () => {
      const input = editorFor({
        blocks: [block("before"), block("equation", "mathBlock"), block("after")],
        cursorIndex: 2,
      });

      expect(planBackspaceAcrossAtomicBlocks(input.editor)).toEqual({ kind: "protect_boundary" });
    });

    test("protects the start of preview-first Math source", () => {
      const input = editorFor({
        blocks: [block("before"), block("equation", "mathBlock")],
        cursorIndex: 1,
      });

      expect(planBackspaceAcrossAtomicBlocks(input.editor)).toEqual({ kind: "protect_boundary" });
    });

    test.each(["heading", "bulletListItem", "toggleListItem", "quote", "callout", "codeBlock"])(
      "leaves %s to the editor's first Backspace normalization",
      (type) => {
        const input = editorFor({
          blocks: [block("before"), block("image", "image"), block("after", type)],
          cursorIndex: 2,
        });

        expect(planBackspaceAcrossAtomicBlocks(input.editor)).toBeNull();
      },
    );

    test("plans within the source Block's own sibling group", () => {
      const before = block("before");
      const image = block("image", "image");
      const after = block("after");
      const parent = { id: "parent", type: "paragraph", children: [before, image, after] };
      const input = editorFor({ blocks: [parent], cursorIndex: 0, parent });
      input.editor.getTextCursorPosition = () => ({ block: after, prevBlock: image });

      expect(planBackspaceAcrossAtomicBlocks(input.editor)).toEqual({
        kind: "merge",
        sourceBlockId: "after",
        targetBlockId: "before",
      });
    });
  });
});

describe("child group backspace", () => {
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
      targetType?: string;
      currentContentModel?: "inline" | "plain" | "none" | "table";
      targetContentModel?: "inline" | "plain" | "none" | "table";
      currentContentSize?: number;
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
      currentContentModel = "inline",
      targetContentModel = "inline",
      targetType = targetContentModel === "plain" ? "codeBlock" : "paragraph",
      currentContentSize = Array.isArray(currentContent) ? currentContent.length : 8,
    } = overrides;

    const parentId = "parent-1";
    const previousSiblingId = "child-0";
    const nextSiblingId = "child-2";
    let focused = false;
    let mergedTarget: string | undefined;
    let mergedSource: string | undefined;
    let updatedType: string | undefined;

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
      type: targetType,
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
        acceptsBlockChildren: (block) => block.type === parentType && parentInline,
        blockSchema: {
          [currentType]: { content: currentContentModel },
          [parentType]: { content: "inline" },
          paragraph: { content: "inline" },
          [targetType]: { content: targetContentModel },
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
      getParentBlock: (id: string) => (hasParent && id === blockId ? parentBlock : undefined),
      getPrevBlock: (id: string) =>
        hasPreviousSibling && id === blockId ? previousSibling : undefined,
      updateBlock: (block, update) => {
        if (block.id === blockId) {
          updatedType = update.type;
        }
        return {
          ...block,
          type: update.type,
          props: update.props,
        };
      },
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
                parent: { content: { size: currentContentSize } },
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
      _updatedType: () => updatedType,
    });
  }

  describe("handleChildGroupBackspace", () => {
    test("resets empty nested checklist tail child to paragraph in place", () => {
      const editor = makeEditor({
        currentType: "checkListItem",
        hasPreviousSibling: true,
        hasNextSibling: false,
        currentContent: [],
      });

      expect(handleChildGroupBackspace(editor)).toBe(true);
      expect(editor._updatedType()).toBe("paragraph");
      expect(editor._mergedTarget()).toBe(undefined);
      expect(editor._focused()).toBe(true);
    });

    test("resets empty nested bullet-list middle child to paragraph in place", () => {
      const editor = makeEditor({
        currentType: "bulletListItem",
        hasPreviousSibling: true,
        hasNextSibling: true,
        currentContent: [],
      });

      expect(handleChildGroupBackspace(editor)).toBe(true);
      expect(editor._updatedType()).toBe("paragraph");
      expect(editor._mergedTarget()).toBe(undefined);
    });

    test("resets empty nested numbered-list first child to paragraph in place", () => {
      const editor = makeEditor({
        currentType: "numberedListItem",
        hasPreviousSibling: false,
        hasNextSibling: true,
        currentContent: [],
      });

      expect(handleChildGroupBackspace(editor)).toBe(true);
      expect(editor._updatedType()).toBe("paragraph");
      expect(editor._mergedTarget()).toBe(undefined);
    });

    test("resets non-empty nested checklist middle child to paragraph in place", () => {
      const editor = makeEditor({
        currentType: "checkListItem",
        hasPreviousSibling: true,
        hasNextSibling: true,
        currentContent: ["childB"],
      });

      expect(handleChildGroupBackspace(editor)).toBe(true);
      expect(editor._updatedType()).toBe("paragraph");
      expect(editor._mergedTarget()).toBe(undefined);
    });

    test("resets non-empty nested bullet-list tail child to paragraph in place", () => {
      const editor = makeEditor({
        currentType: "bulletListItem",
        hasPreviousSibling: true,
        hasNextSibling: false,
        currentContent: ["childB"],
      });

      expect(handleChildGroupBackspace(editor)).toBe(true);
      expect(editor._updatedType()).toBe("paragraph");
      expect(editor._mergedTarget()).toBe(undefined);
    });

    test("resets non-empty nested numbered-list first child to paragraph in place", () => {
      const editor = makeEditor({
        currentType: "numberedListItem",
        hasPreviousSibling: false,
        hasNextSibling: true,
        currentContent: ["childB"],
      });

      expect(handleChildGroupBackspace(editor)).toBe(true);
      expect(editor._updatedType()).toBe("paragraph");
      expect(editor._mergedTarget()).toBe(undefined);
    });

    test("resets empty nested toggle-list child to paragraph in place", () => {
      const editor = makeEditor({
        currentType: "toggleListItem",
        hasPreviousSibling: true,
        hasNextSibling: true,
        currentContent: [],
      });

      expect(handleChildGroupBackspace(editor)).toBe(true);
      expect(editor._updatedType()).toBe("paragraph");
      expect(editor._mergedTarget()).toBe(undefined);
    });

    test("resets non-empty nested toggle-list child to paragraph in place", () => {
      const editor = makeEditor({
        currentType: "toggleListItem",
        hasPreviousSibling: true,
        hasNextSibling: true,
        currentContent: ["childB"],
      });

      expect(handleChildGroupBackspace(editor)).toBe(true);
      expect(editor._updatedType()).toBe("paragraph");
      expect(editor._mergedTarget()).toBe(undefined);
    });

    test("still merges empty nested non-list child upward", () => {
      const editor = makeEditor({
        currentType: "paragraph",
        hasPreviousSibling: true,
        currentContent: [],
        targetContent: ["childA"],
      });

      expect(handleChildGroupBackspace(editor)).toBe(true);
      expect(editor._updatedType()).toBe(undefined);
      expect(editor._mergedTarget()).toBe("child-0");
      expect(editor._mergedSource()).toBe("child-1");
    });

    test("merges child into previous sibling for non-toggle inline parent", () => {
      const editor = makeEditor({
        parentType: "paragraph",
        parentInline: true,
        currentContent: [" World"],
        targetContent: ["Hello"],
      });

      const handled = handleChildGroupBackspace(editor);

      expect(handled).toBe(true);
      expect(editor._mergedTarget()).toBe("child-0");
      expect(editor._mergedSource()).toBe("child-1");
      expect(editor._focused()).toBe(true);
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

      expect(handled).toBe(true);
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

      expect(handleChildGroupBackspace(editor)).toBe(true);
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

      expect(handleChildGroupBackspace(editor)).toBe(true);
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

      expect(handleChildGroupBackspace(editor)).toBe(true);
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

      expect(handleChildGroupBackspace(editor)).toBe(true);
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

      expect(handleChildGroupBackspace(editor)).toBe(true);
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

      expect(handleChildGroupBackspace(editor)).toBe(true);
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

      expect(handleChildGroupBackspace(editor)).toBe(true);
      expect(editor._mergedTarget()).toBe("parent-1");
      expect(editor._mergedSource()).toBe("child-1");
    });

    test("returns false when parent is not inline", () => {
      const editor = makeEditor({
        parentType: "image",
        parentInline: false,
      });

      expect(handleChildGroupBackspace(editor)).toBe(false);
      expect(editor._mergedTarget()).toBe(undefined);
    });

    test("returns false when target content is not an inline array", () => {
      const editor = makeEditor({
        targetContent: { invalid: true },
      });

      expect(handleChildGroupBackspace(editor)).toBe(false);
      expect(editor._mergedTarget()).toBe(undefined);
    });

    test("returns false when current content is not an inline array", () => {
      const editor = makeEditor({
        currentContent: "invalid",
      });

      expect(handleChildGroupBackspace(editor)).toBe(false);
    });

    test("leaves a plain-text child boundary to the plain block shortcut", () => {
      const editor = makeEditor({
        currentType: "codeBlock",
        currentContentModel: "plain",
        currentContent: ["source"],
      });

      expect(handleChildGroupBackspace(editor)).toBe(false);
      expect(editor._mergedTarget()).toBe(undefined);
      expect(editor._updatedType()).toBe(undefined);
    });

    test("leaves a plain-text merge target to the content-model-aware shortcut", () => {
      const editor = makeEditor({
        targetContentModel: "plain",
        currentContent: ["source"],
        targetContent: ["target"],
      });

      expect(handleChildGroupBackspace(editor)).toBe(false);
      expect(editor._mergedTarget()).toBe(undefined);
    });

    test("returns false when block has children", () => {
      const editor = makeEditor({ blockHasChildren: true });
      expect(handleChildGroupBackspace(editor)).toBe(false);
    });

    test("returns false when selection is a range", () => {
      const editor = makeEditor({ selectionEmpty: false });
      expect(handleChildGroupBackspace(editor)).toBe(false);
    });

    test("returns false when cursor is not at block start", () => {
      const editor = makeEditor({ atBlockStart: false });
      expect(handleChildGroupBackspace(editor)).toBe(false);
    });

    test("returns false when parent does not exist", () => {
      const editor = makeEditor({ hasParent: false });
      expect(handleChildGroupBackspace(editor)).toBe(false);
    });
  });
});
