import { describe, expect, test, vi } from "vite-plus/test";
import {
  findVisibleNeighborBlock,
  focusEmbeddedEditorBoundary,
  focusRegisteredEmbeddedSurfaceBoundary,
  handleArrowIntoEmbeddedSurface,
  isEditorAtVisibleBoundary,
  moveFromEmbeddedSurfaceToHostNeighbor,
  registerEmbeddedSurfaceBoundaryHandle,
  type EmbeddedSurfaceHostEditor,
} from "./embedded-surface-arrow-navigation";
import {
  deferCollapsedToggleVerticalArrowToBrowser,
  shouldDeferArrowToBrowserFromCollapsedToggle,
} from "./inline-view-arrow-nav";
import { Schema } from "@tiptap/pm/model";
import { AllSelection, EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { selectCurrentBlockContent } from "./select-block-shortcut";
import { findToggleButtonForBlock, toggleCurrentToggleBlock } from "./toggle-shortcut";

describe("embedded surface arrow navigation", () => {
  interface TestBlock {
    readonly id: string;
    readonly type: string;
    readonly children?: readonly TestBlock[];
  }

  const paragraph = (id: string, children: readonly TestBlock[] = []): TestBlock => ({
    id,
    type: "paragraph",
    children,
  });

  const card = (id: string): TestBlock => ({ id, type: "page", children: [] });

  function makeEditor({
    document = [paragraph("before"), card("shell"), paragraph("after")],
    currentBlockId = "before",
    selection = { empty: true },
    atVisualBoundary = true,
    expanded = () => true,
  }: {
    readonly document?: readonly TestBlock[];
    readonly currentBlockId?: string;
    readonly selection?: { readonly empty: boolean; readonly node?: unknown };
    readonly atVisualBoundary?: boolean;
    readonly expanded?: (blockId: string) => boolean;
  } = {}) {
    const cursorMoves: Array<{ id: string; placement: "start" | "end" }> = [];
    let focused = false;
    const editor: EmbeddedSurfaceHostEditor = {
      document,
      prosemirrorView: {
        state: { selection },
        endOfTextblock: () => atVisualBoundary,
        dom: {
          querySelector: (selector: string) => {
            const match = selector.match(/data-id="([^"]+)"/);
            if (!match) return null;
            const blockId = match[1];
            return {
              querySelector: () => ({
                getAttribute: (name: string) =>
                  name === "data-show-children" ? (expanded(blockId) ? "true" : "false") : null,
              }),
            } as unknown as Element;
          },
        } as unknown as HTMLElement,
      },
      getTextCursorPosition: () => ({
        block: { id: currentBlockId, type: "paragraph" },
      }),
      setTextCursorPosition: (id, placement = "start") => {
        cursorMoves.push({ id, placement });
      },
      focus: () => {
        focused = true;
      },
    };
    return {
      editor,
      cursorMoves,
      get focused() {
        return focused;
      },
    };
  }

  describe("embedded surface arrow navigation", () => {
    test("scopes identical shell ids to their concrete host editor", () => {
      const firstEditor = makeEditor().editor;
      const secondEditor = makeEditor().editor;
      const first = vi.fn(() => true);
      const second = vi.fn(() => true);

      const unregisterFirst = registerEmbeddedSurfaceBoundaryHandle(firstEditor, "shell", {
        focusBoundary: first,
      });
      registerEmbeddedSurfaceBoundaryHandle(secondEditor, "shell", {
        focusBoundary: second,
      });

      expect(focusRegisteredEmbeddedSurfaceBoundary(firstEditor, "shell", "down")).toBe(true);
      expect(focusRegisteredEmbeddedSurfaceBoundary(secondEditor, "shell", "up")).toBe(true);
      expect(first).toHaveBeenCalledWith("down");
      expect(second).toHaveBeenCalledWith("up");

      unregisterFirst();
      expect(focusRegisteredEmbeddedSurfaceBoundary(firstEditor, "shell", "down")).toBe(false);
      expect(focusRegisteredEmbeddedSurfaceBoundary(secondEditor, "shell", "down")).toBe(true);
    });

    test("does not let stale cleanup remove a newer handle", () => {
      const editor = makeEditor().editor;
      const oldHandle = { focusBoundary: vi.fn(() => true) };
      const newHandle = { focusBoundary: vi.fn(() => true) };
      const unregisterOld = registerEmbeddedSurfaceBoundaryHandle(editor, "shell", oldHandle);
      registerEmbeddedSurfaceBoundaryHandle(editor, "shell", newHandle);

      unregisterOld();

      expect(focusRegisteredEmbeddedSurfaceBoundary(editor, "shell", "down")).toBe(true);
      expect(oldHandle.focusBoundary).not.toHaveBeenCalled();
      expect(newHandle.focusBoundary).toHaveBeenCalledWith("down");
    });

    test("finds visible depth-first neighbors and prunes collapsed descendants", () => {
      const blocks = [
        paragraph("parent", [paragraph("child-a"), paragraph("child-b")]),
        card("shell"),
        paragraph("tail"),
      ];

      expect(findVisibleNeighborBlock(blocks, "child-a", "down", () => true)?.id).toBe("child-b");
      expect(findVisibleNeighborBlock(blocks, "shell", "up", () => true)?.id).toBe("child-b");
      expect(findVisibleNeighborBlock(blocks, "shell", "up", (id) => id !== "parent")?.id).toBe(
        "parent",
      );
      expect(findVisibleNeighborBlock(blocks, "child-b", "down", () => true)?.id).toBe("shell");
    });

    test("enters an adjacent surface only at a visual textblock boundary", () => {
      const atBoundary = makeEditor({ atVisualBoundary: true });
      const insideWrappedLine = makeEditor({ atVisualBoundary: false });
      const focus = vi.fn(() => true);
      registerEmbeddedSurfaceBoundaryHandle(atBoundary.editor, "shell", { focusBoundary: focus });
      registerEmbeddedSurfaceBoundaryHandle(insideWrappedLine.editor, "shell", {
        focusBoundary: focus,
      });

      expect(handleArrowIntoEmbeddedSurface(atBoundary.editor, "down")).toBe(true);
      expect(atBoundary.cursorMoves).toEqual([{ id: "shell", placement: "start" }]);
      expect(handleArrowIntoEmbeddedSurface(insideWrappedLine.editor, "down")).toBe(false);
      expect(insideWrappedLine.cursorMoves).toEqual([]);
      expect(focus).toHaveBeenCalledTimes(1);
    });

    test("enters a selected childless shell without requiring a text boundary", () => {
      const selected = makeEditor({
        currentBlockId: "shell",
        selection: { empty: false, node: {} },
        atVisualBoundary: false,
      });
      const focus = vi.fn(() => true);
      registerEmbeddedSurfaceBoundaryHandle(selected.editor, "shell", { focusBoundary: focus });

      expect(handleArrowIntoEmbeddedSurface(selected.editor, "up")).toBe(true);
      expect(focus).toHaveBeenCalledWith("up");
    });

    test("does not intercept a range selection on the same block", () => {
      const selected = makeEditor({
        currentBlockId: "before",
        selection: { empty: false },
        atVisualBoundary: true,
      });
      registerEmbeddedSurfaceBoundaryHandle(selected.editor, "shell", {
        focusBoundary: () => true,
      });

      expect(handleArrowIntoEmbeddedSurface(selected.editor, "down")).toBe(false);
    });

    test("moves from a surface to a structural host neighbor or directly into the next surface", () => {
      const normalNeighbor = makeEditor();
      expect(moveFromEmbeddedSurfaceToHostNeighbor(normalNeighbor.editor, "shell", "down")).toBe(
        true,
      );
      expect(normalNeighbor.cursorMoves).toEqual([{ id: "after", placement: "start" }]);
      expect(normalNeighbor.focused).toBe(true);

      const consecutive = makeEditor({
        document: [paragraph("before"), card("shell"), card("second"), paragraph("after")],
      });
      const focusSecond = vi.fn(() => true);
      registerEmbeddedSurfaceBoundaryHandle(consecutive.editor, "second", {
        focusBoundary: focusSecond,
      });
      expect(moveFromEmbeddedSurfaceToHostNeighbor(consecutive.editor, "shell", "down")).toBe(true);
      expect(focusSecond).toHaveBeenCalledWith("down");
      expect(consecutive.cursorMoves).toEqual([{ id: "second", placement: "start" }]);
    });

    test("focuses the first or last visible boundary of an embedded editor", () => {
      const editor = makeEditor({
        document: [paragraph("parent", [paragraph("hidden")]), paragraph("tail")],
        expanded: (id) => id !== "parent",
      });

      expect(focusEmbeddedEditorBoundary(editor.editor, "down")).toBe(true);
      expect(focusEmbeddedEditorBoundary(editor.editor, "up")).toBe(true);
      expect(editor.cursorMoves).toEqual([
        { id: "parent", placement: "start" },
        { id: "tail", placement: "end" },
      ]);
    });

    test("reports an embedded editor boundary only at its first or last visible block", () => {
      const first = makeEditor({ currentBlockId: "before" });
      const middle = makeEditor({ currentBlockId: "shell" });
      const last = makeEditor({ currentBlockId: "after" });
      const notVisual = makeEditor({ currentBlockId: "after", atVisualBoundary: false });

      expect(isEditorAtVisibleBoundary(first.editor, "up")).toBe(true);
      expect(isEditorAtVisibleBoundary(first.editor, "down")).toBe(false);
      expect(isEditorAtVisibleBoundary(middle.editor, "up")).toBe(false);
      expect(isEditorAtVisibleBoundary(last.editor, "down")).toBe(true);
      expect(isEditorAtVisibleBoundary(notVisual.editor, "down")).toBe(false);
    });
  });
});

describe("inline view arrow nav", () => {
  function makeCollapsedToggleArrowDom({
    collapsed,
    selectionInHeader,
    withSelection = true,
    firstChildNonCommon = false,
    lastChildNonCommon = false,
  }: {
    collapsed: boolean;
    selectionInHeader: boolean;
    withSelection?: boolean;
    firstChildNonCommon?: boolean;
    lastChildNonCommon?: boolean;
  }) {
    const selectionAnchor = { id: "selection-anchor" };
    const insideHeaderTarget = { id: "inside-header" };
    const outsideTarget = { id: "outside-target" };
    const commonBlockContent = {
      querySelector: (selector: string) =>
        selector === ".bn-inline-content" ? { id: "inline" } : null,
    } as unknown as HTMLElement;
    const nonCommonBlockContent = {
      querySelector: () => null,
    } as unknown as HTMLElement;

    const childGroup = {
      contains: (candidate: unknown) => !selectionInHeader && candidate === selectionAnchor,
      querySelector: (selector: string) => {
        if (selector === ":scope > .bn-block-outer:first-child > .bn-block .bn-block-content") {
          return firstChildNonCommon ? nonCommonBlockContent : commonBlockContent;
        }
        if (selector === ":scope > .bn-block-outer:last-child > .bn-block .bn-block-content") {
          return lastChildNonCommon ? nonCommonBlockContent : commonBlockContent;
        }
        return null;
      },
    };

    const toggleWrapper = {
      getAttribute: (name: string) =>
        name === "data-show-children" ? (collapsed ? "false" : "true") : null,
    };

    const currentBlock = {
      contains: (candidate: unknown) =>
        candidate === selectionAnchor || candidate === insideHeaderTarget,
      querySelector: (selector: string) => {
        if (selector === ".bn-toggle-wrapper") return toggleWrapper;
        if (selector === ":scope > .bn-block-group" || selector === ".bn-block-group")
          return childGroup;
        return null;
      },
    };

    const paragraphBlock = {
      contains: () => false,
      querySelector: () => null,
    };

    const editorDom = {
      ownerDocument: {
        getSelection: () => (withSelection ? { anchorNode: selectionAnchor } : null),
      },
      querySelector: (selector: string) => {
        if (selector === '.bn-block[data-id="toggle-1"]') return currentBlock;
        if (selector === '.bn-block[data-id="para-1"]') return paragraphBlock;
        if (selector === '.bn-block[data-id="para-2"]') return paragraphBlock;
        return null;
      },
    } as unknown as ParentNode;

    return { editorDom, insideHeaderTarget, outsideTarget };
  }

  function makeArrowEditor({
    blockId,
    prevBlock,
    nextBlock,
    parentOffset,
    parentSize,
  }: {
    blockId: string;
    prevBlock?: { id: string; type: string };
    nextBlock?: { id: string; type: string };
    parentOffset: number;
    parentSize: number;
  }) {
    return {
      getTextCursorPosition: () => ({
        block: { id: blockId, type: "paragraph" },
        prevBlock,
        nextBlock,
      }),
      transact: <T>(
        fn: (tr: {
          selection: {
            anchor: number;
            head: number;
            $anchor: {
              parentOffset: number;
              parent: {
                content: {
                  size: number;
                };
              };
            };
          };
        }) => T,
      ) =>
        fn({
          selection: {
            anchor: 1,
            head: 1,
            $anchor: { parentOffset, parent: { content: { size: parentSize } } },
          },
        }),
    };
  }

  describe("inline view arrow navigation", () => {
    test("collapsed-toggle ArrowDown defers for collapsed header selection", () => {
      const { editorDom, outsideTarget } = makeCollapsedToggleArrowDom({
        collapsed: true,
        selectionInHeader: true,
      });

      const shouldDefer = shouldDeferArrowToBrowserFromCollapsedToggle(
        makeArrowEditor({
          blockId: "toggle-1",
          parentOffset: 1,
          parentSize: 4,
        }),
        editorDom,
        "next",
        outsideTarget as unknown as EventTarget,
      );

      expect(shouldDefer).toBe(true);
    });

    test("collapsed-toggle ArrowUp defers for collapsed header selection", () => {
      const { editorDom, outsideTarget } = makeCollapsedToggleArrowDom({
        collapsed: true,
        selectionInHeader: true,
      });

      const shouldDefer = shouldDeferArrowToBrowserFromCollapsedToggle(
        makeArrowEditor({
          blockId: "toggle-1",
          parentOffset: 1,
          parentSize: 4,
        }),
        editorDom,
        "prev",
        outsideTarget as unknown as EventTarget,
      );

      expect(shouldDefer).toBe(true);
    });

    test("collapsed-toggle ArrowDown does not defer when expanded", () => {
      const { editorDom, insideHeaderTarget } = makeCollapsedToggleArrowDom({
        collapsed: false,
        selectionInHeader: true,
      });

      const shouldDefer = shouldDeferArrowToBrowserFromCollapsedToggle(
        makeArrowEditor({
          blockId: "toggle-1",
          parentOffset: 1,
          parentSize: 4,
        }),
        editorDom,
        "next",
        insideHeaderTarget as unknown as EventTarget,
      );

      expect(shouldDefer).toBe(false);
    });

    test("collapsed-toggle ArrowDown does not defer when selection is inside child group", () => {
      const { editorDom, insideHeaderTarget } = makeCollapsedToggleArrowDom({
        collapsed: true,
        selectionInHeader: false,
      });

      const shouldDefer = shouldDeferArrowToBrowserFromCollapsedToggle(
        makeArrowEditor({
          blockId: "toggle-1",
          parentOffset: 1,
          parentSize: 4,
        }),
        editorDom,
        "next",
        insideHeaderTarget as unknown as EventTarget,
      );

      expect(shouldDefer).toBe(false);
    });

    test("collapsed-toggle ArrowDown falls back to key target when selection is unavailable", () => {
      const { editorDom, insideHeaderTarget } = makeCollapsedToggleArrowDom({
        collapsed: true,
        selectionInHeader: true,
        withSelection: false,
      });

      const shouldDefer = shouldDeferArrowToBrowserFromCollapsedToggle(
        makeArrowEditor({
          blockId: "toggle-1",
          parentOffset: 1,
          parentSize: 4,
        }),
        editorDom,
        "next",
        insideHeaderTarget as unknown as EventTarget,
      );

      expect(shouldDefer).toBe(true);
    });

    test("collapsed-toggle ArrowDown does not defer for key target outside header when no selection", () => {
      const { editorDom, outsideTarget } = makeCollapsedToggleArrowDom({
        collapsed: true,
        selectionInHeader: true,
        withSelection: false,
      });

      const shouldDefer = shouldDeferArrowToBrowserFromCollapsedToggle(
        makeArrowEditor({
          blockId: "toggle-1",
          parentOffset: 1,
          parentSize: 4,
        }),
        editorDom,
        "next",
        outsideTarget as unknown as EventTarget,
      );

      expect(shouldDefer).toBe(false);
    });

    test("collapsed-toggle ArrowDown defers when next collapsed toggle hides a first non-common child", () => {
      const { editorDom, outsideTarget } = makeCollapsedToggleArrowDom({
        collapsed: true,
        selectionInHeader: true,
        firstChildNonCommon: true,
      });

      const shouldDefer = shouldDeferArrowToBrowserFromCollapsedToggle(
        makeArrowEditor({
          blockId: "para-1",
          nextBlock: { id: "toggle-1", type: "toggleListItem" },
          parentOffset: 4,
          parentSize: 4,
        }),
        editorDom,
        "next",
        outsideTarget as unknown as EventTarget,
      );

      expect(shouldDefer).toBe(true);
    });

    test("collapsed-toggle ArrowUp defers when previous collapsed toggle hides a last non-common child", () => {
      const { editorDom, outsideTarget } = makeCollapsedToggleArrowDom({
        collapsed: true,
        selectionInHeader: true,
        lastChildNonCommon: true,
      });

      const shouldDefer = shouldDeferArrowToBrowserFromCollapsedToggle(
        makeArrowEditor({
          blockId: "para-2",
          prevBlock: { id: "toggle-1", type: "toggleListItem" },
          parentOffset: 0,
          parentSize: 4,
        }),
        editorDom,
        "prev",
        outsideTarget as unknown as EventTarget,
      );

      expect(shouldDefer).toBe(true);
    });

    test("collapsed-toggle boundary arrows do not defer for common inline edge children", () => {
      const { editorDom, outsideTarget } = makeCollapsedToggleArrowDom({
        collapsed: true,
        selectionInHeader: true,
      });

      const shouldDefer = shouldDeferArrowToBrowserFromCollapsedToggle(
        makeArrowEditor({
          blockId: "para-2",
          prevBlock: { id: "toggle-1", type: "toggleListItem" },
          parentOffset: 0,
          parentSize: 4,
        }),
        editorDom,
        "prev",
        outsideTarget as unknown as EventTarget,
      );

      expect(shouldDefer).toBe(false);
    });

    test("deferCollapsedToggleVerticalArrowToBrowser stops immediate propagation for hidden edge non-common arrows", () => {
      const { editorDom, outsideTarget } = makeCollapsedToggleArrowDom({
        collapsed: true,
        selectionInHeader: true,
        lastChildNonCommon: true,
      });
      let stopped = false;

      const deferred = deferCollapsedToggleVerticalArrowToBrowser(
        makeArrowEditor({
          blockId: "para-2",
          prevBlock: { id: "toggle-1", type: "toggleListItem" },
          parentOffset: 0,
          parentSize: 4,
        }),
        editorDom,
        "prev",
        {
          target: outsideTarget as unknown as EventTarget,
          stopImmediatePropagation: () => {
            stopped = true;
          },
        },
      );

      expect(deferred).toBe(true);
      expect(stopped).toBe(true);
    });
  });
});

describe("select block shortcut", () => {
  const pmSchema = new Schema({
    nodes: {
      doc: { content: "textBlock+" },
      textBlock: { content: "text*", group: "block" },
      text: { group: "inline" },
    },
  });

  function editorFor(contentType: string) {
    const doc = pmSchema.node("doc", null, [
      pmSchema.node("textBlock", null, pmSchema.text("Alpha")),
    ]);
    let state = EditorState.create({
      schema: pmSchema,
      doc,
      selection: TextSelection.create(doc, 3),
    });
    return {
      editor: {
        schema: { blockSchema: { editableBlock: { content: contentType } } },
        prosemirrorView: {
          get state() {
            return state;
          },
          dispatch(transaction: Transaction) {
            state = state.apply(transaction);
          },
        },
        getTextCursorPosition: () => ({ block: { id: "editable-1", type: "editableBlock" } }),
      },
      getState: () => state,
    };
  }

  describe("select block shortcut", () => {
    test.each(["inline", "plain"])(
      "progressively selects %s text content in the ProseMirror model",
      (contentType) => {
        const { editor, getState } = editorFor(contentType);
        const browserSelection = {} as Selection;

        expect(selectCurrentBlockContent(editor, browserSelection)).toBe(true);
        expect(getState().selection).toBeInstanceOf(TextSelection);
        expect(getState().selection.from).toBe(1);
        expect(getState().selection.to).toBe(6);

        expect(selectCurrentBlockContent(editor, browserSelection)).toBe(true);
        expect(getState().selection).toBeInstanceOf(AllSelection);
      },
    );

    test.each(["none", "table"])("leaves %s selection to its structural owner", (contentType) => {
      const { editor, getState } = editorFor(contentType);

      expect(selectCurrentBlockContent(editor, {} as Selection)).toBe(false);
      expect(getState().selection.empty).toBe(true);
    });
  });
});

describe("toggle shortcut", () => {
  test("findToggleButtonForBlock finds the current block toggle button", () => {
    const expectedSelector = '.bn-block[data-id="abc1234"] .bn-toggle-button';
    const button = { click: () => {} } as HTMLButtonElement;
    const root = {
      querySelector: (selector: string) => (selector === expectedSelector ? button : null),
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
      querySelector: (selector: string) => (selector === expectedSelector ? button : null),
    } as unknown as ParentNode;

    const didToggle = toggleCurrentToggleBlock({
      domElement: root,
      getTextCursorPosition: () => ({
        block: { id: "toggle-1", type: "toggleListItem" },
      }),
    });

    expect(didToggle).toBe(true);
    expect(clicked).toBe(true);
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

    expect(didToggle).toBe(false);
  });
});
