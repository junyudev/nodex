import { describe, expect, test } from "bun:test";
import {
  deferCollapsedToggleVerticalArrowToBrowser,
  focusInlineSummaryBoundary,
  handleArrowFromInlineBlockSelection,
  handleArrowIntoInlineSummary,
  moveFromInlineSummaryToNeighborBlock,
  registerInlineSummaryBoundaryHandle,
  shouldDeferArrowToBrowserFromCollapsedToggle,
  unregisterInlineSummaryBoundaryHandle,
} from "./inline-view-arrow-nav";

function makeBlockNode(id: string) {
  return {
    getAttribute: (name: string) => (name === "data-id" ? id : null),
  } as unknown as HTMLElement;
}

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
    querySelector: (selector: string) => (selector === ".bn-inline-content" ? { id: "inline" } : null),
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
      name === "data-show-children"
        ? (collapsed ? "false" : "true")
        : null,
  };

  const currentBlock = {
    contains: (candidate: unknown) =>
      candidate === selectionAnchor || candidate === insideHeaderTarget,
    querySelector: (selector: string) => {
      if (selector === ".bn-toggle-wrapper") return toggleWrapper;
      if (selector === ":scope > .bn-block-group" || selector === ".bn-block-group") return childGroup;
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
    transact: <T,>(fn: (tr: {
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
    }) => T) =>
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
  test("focusInlineSummaryBoundary delegates to registered handle", () => {
    const calls: string[] = [];
    const handle = {
      focusBoundarySummary: (direction: "prev" | "next") => {
        calls.push(direction);
        return direction === "next";
      },
    };

    registerInlineSummaryBoundaryHandle("inline-1", handle);
    expect(focusInlineSummaryBoundary("inline-1", "next")).toBeTrue();
    expect(focusInlineSummaryBoundary("inline-1", "prev")).toBeFalse();
    expect(JSON.stringify(calls)).toBe(JSON.stringify(["next", "prev"]));
    unregisterInlineSummaryBoundaryHandle("inline-1", handle);
  });

  test("moveFromInlineSummaryToNeighborBlock uses top-level selector only", () => {
    const topLevelBlocks = ["block-a", "inline-1", "block-c"].map(makeBlockNode);
    const nestedSensitiveBlocks = ["block-a", "inline-1", "nested-1", "block-c"].map(makeBlockNode);

    let movedToId: string | null = null;
    let movedToPlacement: "start" | "end" | null = null;
    let focused = false;

    const moved = moveFromInlineSummaryToNeighborBlock(
      {
        domElement: {
          querySelectorAll: (selector: string) => {
            if (selector === ":scope > .bn-block-outer > .bn-block[data-id]") {
              return topLevelBlocks;
            }
            if (selector === ".bn-block[data-id]") {
              return nestedSensitiveBlocks;
            }
            return [];
          },
        } as unknown as ParentNode,
        setTextCursorPosition: (id, placement) => {
          movedToId = id;
          movedToPlacement = placement;
        },
        focus: () => {
          focused = true;
        },
      },
      "inline-1",
      "next",
    );

    expect(moved).toBeTrue();
    expect(movedToId).toBe("block-c");
    expect(movedToPlacement).toBe("start");
    expect(focused).toBeTrue();
  });

  test("moveFromInlineSummaryToNeighborBlock returns false when no neighbor block", () => {
    const moved = moveFromInlineSummaryToNeighborBlock(
      {
        domElement: {
          querySelectorAll: () => [makeBlockNode("inline-1")],
        } as unknown as ParentNode,
        setTextCursorPosition: () => {
          throw new Error("should not move");
        },
        focus: () => {
          throw new Error("should not focus");
        },
      },
      "inline-1",
      "prev",
    );

    expect(moved).toBeFalse();
  });

  test("handleArrowIntoInlineSummary moves from normal block into inline summary handle", () => {
    const calls: Array<"prev" | "next"> = [];
    const handle = {
      focusBoundarySummary: (direction: "prev" | "next") => {
        calls.push(direction);
        return true;
      },
    };

    registerInlineSummaryBoundaryHandle("inline-1", handle);
    const downMoved = handleArrowIntoInlineSummary(
      {
        getTextCursorPosition: () => ({
          block: { id: "para-1", type: "paragraph" },
          nextBlock: { id: "inline-1", type: "toggleListInlineView" },
          prevBlock: undefined,
        }),
        transact: (fn) =>
          fn({
            selection: {
              anchor: 1,
              head: 1,
              $anchor: { parentOffset: 4, parent: { content: { size: 4 } } },
            },
          }),
      },
      "next",
    );

    const upMoved = handleArrowIntoInlineSummary(
      {
        getTextCursorPosition: () => ({
          block: { id: "para-2", type: "paragraph" },
          nextBlock: undefined,
          prevBlock: { id: "inline-1", type: "toggleListInlineView" },
        }),
        transact: (fn) =>
          fn({
            selection: {
              anchor: 2,
              head: 2,
              $anchor: { parentOffset: 0, parent: { content: { size: 6 } } },
            },
          }),
      },
      "prev",
    );

    expect(downMoved).toBeTrue();
    expect(upMoved).toBeTrue();
    expect(JSON.stringify(calls)).toBe(JSON.stringify(["next", "prev"]));
    unregisterInlineSummaryBoundaryHandle("inline-1", handle);
  });

  test("handleArrowIntoInlineSummary returns false when not at block boundary", () => {
    const moved = handleArrowIntoInlineSummary(
      {
        getTextCursorPosition: () => ({
          block: { id: "para-1", type: "paragraph" },
          nextBlock: { id: "inline-1", type: "toggleListInlineView" },
          prevBlock: undefined,
        }),
        transact: (fn) =>
          fn({
            selection: {
              anchor: 1,
              head: 1,
              $anchor: { parentOffset: 1, parent: { content: { size: 4 } } },
            },
          }),
      },
      "next",
    );
    expect(moved).toBeFalse();
  });

  test("handleArrowFromInlineBlockSelection enters first/last summary from selected inline block", () => {
    const calls: Array<"prev" | "next"> = [];
    const handle = {
      focusBoundarySummary: (direction: "prev" | "next") => {
        calls.push(direction);
        return true;
      },
    };

    registerInlineSummaryBoundaryHandle("inline-1", handle);
    const upHandled = handleArrowFromInlineBlockSelection(
      {
        getTextCursorPosition: () => ({
          block: { id: "inline-1", type: "toggleListInlineView" },
          nextBlock: { id: "para-2", type: "paragraph" },
          prevBlock: { id: "para-1", type: "paragraph" },
        }),
        transact: (fn) =>
          fn({
            selection: {
              anchor: 1,
              head: 1,
              $anchor: { parentOffset: 0, parent: { content: { size: 0 } } },
            },
          }),
      },
      "prev",
    );

    const downHandled = handleArrowFromInlineBlockSelection(
      {
        getTextCursorPosition: () => ({
          block: { id: "inline-1", type: "toggleListInlineView" },
          nextBlock: { id: "para-2", type: "paragraph" },
          prevBlock: { id: "para-1", type: "paragraph" },
        }),
        transact: (fn) =>
          fn({
            selection: {
              anchor: 1,
              head: 1,
              $anchor: { parentOffset: 0, parent: { content: { size: 0 } } },
            },
          }),
      },
      "next",
    );

    expect(upHandled).toBeTrue();
    expect(downHandled).toBeTrue();
    expect(JSON.stringify(calls)).toBe(JSON.stringify(["prev", "next"]));
    unregisterInlineSummaryBoundaryHandle("inline-1", handle);
  });

  test("handleArrowFromInlineBlockSelection returns false for non-inline current block", () => {
    const handled = handleArrowFromInlineBlockSelection(
      {
        getTextCursorPosition: () => ({
          block: { id: "para-1", type: "paragraph" },
          nextBlock: { id: "inline-1", type: "toggleListInlineView" },
          prevBlock: undefined,
        }),
        transact: (fn) =>
          fn({
            selection: {
              anchor: 1,
              head: 1,
              $anchor: { parentOffset: 0, parent: { content: { size: 1 } } },
            },
          }),
      },
      "next",
    );
    expect(handled).toBeFalse();
  });

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

    expect(shouldDefer).toBeTrue();
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

    expect(shouldDefer).toBeTrue();
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

    expect(shouldDefer).toBeFalse();
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

    expect(shouldDefer).toBeFalse();
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

    expect(shouldDefer).toBeTrue();
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

    expect(shouldDefer).toBeFalse();
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

    expect(shouldDefer).toBeTrue();
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

    expect(shouldDefer).toBeTrue();
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

    expect(shouldDefer).toBeFalse();
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

    expect(deferred).toBeTrue();
    expect(stopped).toBeTrue();
  });
});
