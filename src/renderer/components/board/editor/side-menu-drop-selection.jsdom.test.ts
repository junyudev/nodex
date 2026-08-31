import { describe, expect, test, vi } from "vite-plus/test";
import { BlockNoteEditor } from "@blocknote/core";
import {
  BLOCKNOTE_SLICE_MIME,
  createSideMenuDroppedBlockSelection,
  getSideMenuDroppedBlockIdsFromSelection,
  getSideMenuDroppedBlockIdsFromSlice,
  MultipleNodeSelection,
  SideMenuExtension,
  SideMenuView,
} from "@blocknote/core/extensions";
import { Fragment, Schema, Slice } from "@tiptap/pm/model";
import { EditorState, NodeSelection, type Selection } from "@tiptap/pm/state";

const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "block*" },
    block: {
      attrs: { id: {} },
      content: "text*",
      group: "bnBlock block",
      toDOM: (node) => ["div", { "data-id": node.attrs.id }, 0],
      parseDOM: [{ tag: "div[data-id]" }],
    },
    text: { group: "inline" },
  },
  marks: {},
});

const atomicSchema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer*" },
    blockContainer: {
      attrs: { id: {} },
      content: "blockContent",
      group: "bnBlock",
    },
    atomicBlock: { atom: true, group: "blockContent" },
    text: { group: "inline" },
  },
  marks: {},
});

function makeBlock(id: string, text = id) {
  return schema.node("block", { id }, schema.text(text));
}

function makeDoc() {
  return schema.node("doc", null, [
    schema.node("blockGroup", null, [makeBlock("a"), makeBlock("b"), makeBlock("c")]),
  ]);
}

function selectionIds(selection: Selection | undefined) {
  if (!selection) return "";
  const blockSelection = selection as Selection & {
    node?: { attrs?: { id?: string } };
    nodes?: Array<{ attrs?: { id?: string } }>;
  };
  if (Array.isArray(blockSelection.nodes)) {
    return blockSelection.nodes.map((node) => node.attrs?.id ?? "").join(",");
  }
  return blockSelection.node?.attrs?.id ?? "";
}

function setRect(element: Element, rect: DOMRect) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
}

function makeEditorCandidate(id: string, rect: DOMRect) {
  const editor = document.createElement("div");
  const blockGroup = document.createElement("div");
  const block = document.createElement("div");
  editor.className = "bn-editor";
  blockGroup.className = "bn-block-group";
  block.dataset.nodeType = "blockContainer";
  block.dataset.id = id;
  blockGroup.appendChild(block);
  editor.appendChild(blockGroup);
  setRect(editor, rect);
  setRect(blockGroup, rect);
  setRect(block, rect);
  return { editor, blockGroup, block };
}

function installElementsFromPoint(
  root: Document | ShadowRoot,
  resolve: (clientX: number, clientY: number) => Element[],
) {
  const original = root.elementsFromPoint;
  Object.defineProperty(root, "elementsFromPoint", {
    configurable: true,
    value: resolve,
  });
  return () => {
    if (original) {
      Object.defineProperty(root, "elementsFromPoint", {
        configurable: true,
        value: original,
      });
      return;
    }
    Reflect.deleteProperty(root, "elementsFromPoint");
  };
}

function makeSideMenuView(
  active: ReturnType<typeof makeEditorCandidate>,
  root: Document | ShadowRoot = document,
  interactionOwnership: (event: Event) => "self" | "other" | "none" = () => "none",
) {
  const droppedSlice = new Slice(Fragment.from(makeBlock(active.block.dataset.id!)), 0, 0);
  const pmView = {
    dom: active.editor,
    root,
    dragging: {
      slice: droppedSlice,
      move: true,
    },
    dispatch: () => {},
  };
  let hoveredBlockId = "";
  let visible = false;
  const view = new SideMenuView(
    {
      isEditable: true,
      isWithinEditor: (element: Element) => active.editor.contains(element),
      getInteractionOwnership: interactionOwnership,
      getBlock: (id: string) => ({ id }),
    } as never,
    pmView as never,
    (state) => {
      visible = state.show;
      if (state.show) hoveredBlockId = state.block.id;
    },
    () => {},
    () => {},
  );

  return {
    view,
    getHoveredBlockId: () => hoveredBlockId,
    isVisible: () => visible,
  };
}

function makePointerEvent(
  type: "mousemove" | "dragover",
  target: Element,
  path: EventTarget[],
  clientX: number,
  clientY: number,
) {
  const event =
    type === "mousemove"
      ? new MouseEvent(type, { bubbles: true, clientX, clientY })
      : makeDropEvent(type, clientX, clientY);
  Object.defineProperties(event, {
    target: { configurable: true, value: target },
    composedPath: { configurable: true, value: () => path },
  });
  return event;
}

function makeDropEvent(type: string, clientX: number, clientY: number) {
  const event = new Event(type, { bubbles: true }) as DragEvent;
  Object.defineProperties(event, {
    clientX: { configurable: true, value: clientX },
    clientY: { configurable: true, value: clientY },
    dataTransfer: {
      configurable: true,
      value: {
        types: [BLOCKNOTE_SLICE_MIME],
      },
    },
  });
  return event;
}

describe("side-menu drop selection helpers", () => {
  test("creates a block-range selection for one dropped block id", () => {
    const selection = createSideMenuDroppedBlockSelection(makeDoc(), ["b"]);

    expect(selection instanceof MultipleNodeSelection).toBe(true);
    expect(selectionIds(selection)).toBe("b");
  });

  test("creates a MultipleNodeSelection for adjacent dropped block ids", () => {
    const selection = createSideMenuDroppedBlockSelection(makeDoc(), ["c", "b"]);

    expect(selection instanceof MultipleNodeSelection).toBe(true);
    expect(selectionIds(selection)).toBe("b,c");
  });

  test("extracts dropped block ids from node-level selections and slices", () => {
    const doc = makeDoc();
    const selection = createSideMenuDroppedBlockSelection(doc, ["b", "c"]);
    const slice = new Slice(Fragment.fromArray([makeBlock("x"), makeBlock("y")]), 0, 0);

    expect(getSideMenuDroppedBlockIdsFromSelection(selection!).join(",")).toBe("b,c");
    expect(getSideMenuDroppedBlockIdsFromSlice(slice).join(",")).toBe("x,y");
  });

  test("extracts the dragged block id from a single node selection slice", () => {
    const doc = makeDoc();
    const selection = createSideMenuDroppedBlockSelection(doc, ["b"]);

    expect(getSideMenuDroppedBlockIdsFromSlice(selection!.content()).join(",")).toBe("b");
  });

  test("extracts an atomic content selection through its owning Block", () => {
    const doc = atomicSchema.node("doc", null, [
      atomicSchema.node("blockGroup", null, [
        atomicSchema.node("blockContainer", { id: "atomic" }, [atomicSchema.node("atomicBlock")]),
      ]),
    ]);
    const block = doc.firstChild?.firstChild;
    if (!block) throw new Error("Missing atomic fixture Block");
    const selection = NodeSelection.create(doc, 2);

    expect(getSideMenuDroppedBlockIdsFromSelection(selection)).toEqual(["atomic"]);
  });

  test("returns undefined when dropped ids are not in the new document", () => {
    expect(createSideMenuDroppedBlockSelection(makeDoc(), ["missing"]) === undefined).toBe(true);
  });

  test("ignores non-interactive editor geometry for side-menu hover and drop routing", () => {
    const excludedRect = new DOMRect(100, 100, 300, 300);
    const activeRect = new DOMRect(120, 100, 300, 300);
    const hidden = makeEditorCandidate("hidden", excludedRect);
    hidden.editor.style.visibility = "hidden";

    const inert = makeEditorCandidate("inert", excludedRect);
    const inertHost = document.createElement("div");
    inertHost.setAttribute("inert", "");
    inertHost.appendChild(inert.editor);

    const pointerDisabled = makeEditorCandidate("pointer-disabled", excludedRect);
    pointerDisabled.editor.style.pointerEvents = "none";

    const incomplete = document.createElement("div");
    incomplete.className = "bn-editor";

    const active = makeEditorCandidate("active", activeRect);
    document.body.append(
      hidden.editor,
      inertHost,
      pointerDisabled.editor,
      incomplete,
      active.editor,
    );

    const restoreElementsFromPoint = installElementsFromPoint(document, (clientX) =>
      clientX >= activeRect.left ? [active.block] : [],
    );
    const runtime = makeSideMenuView(active);

    try {
      runtime.view.onMouseMove(new MouseEvent("mousemove", { clientX: 90, clientY: 150 }));
      const dragContext = runtime.view.getDragEventContext(makeDropEvent("dragover", 90, 150));

      expect(runtime.getHoveredBlockId()).toBe("active");
      expect(dragContext).toMatchObject({
        isDropPoint: true,
        isDropWithinEditorBounds: false,
      });
    } finally {
      runtime.view.destroy();
      restoreElementsFromPoint();
      hidden.editor.remove();
      inertHost.remove();
      pointerDisabled.editor.remove();
      incomplete.remove();
      active.editor.remove();
    }
  });

  test("prefers the browser hit-tested editor when visible editors overlap", () => {
    const rect = new DOMRect(100, 100, 300, 300);
    const lower = makeEditorCandidate("lower", rect);
    const top = makeEditorCandidate("top", rect);
    top.editor.style.pointerEvents = "none";
    top.blockGroup.style.pointerEvents = "auto";
    document.body.append(lower.editor, top.editor);

    const restoreElementsFromPoint = installElementsFromPoint(document, () => [
      top.block,
      lower.block,
    ]);
    const runtime = makeSideMenuView(top);

    try {
      runtime.view.onMouseMove(new MouseEvent("mousemove", { clientX: 150, clientY: 150 }));
      const dragContext = runtime.view.getDragEventContext(makeDropEvent("dragover", 150, 150));

      expect(runtime.getHoveredBlockId()).toBe("top");
      expect(dragContext).toMatchObject({
        isDropPoint: true,
        isDropWithinEditorBounds: true,
      });
    } finally {
      runtime.view.destroy();
      restoreElementsFromPoint();
      lower.editor.remove();
      top.editor.remove();
    }
  });

  test("keeps nested editor hover and drop ownership while crossing into its portaled side menu", () => {
    const outer = makeEditorCandidate("outer", new DOMRect(80, 80, 440, 360));
    const inner = makeEditorCandidate("inner", new DOMRect(120, 120, 360, 240));
    const innerContainer = document.createElement("div");
    const innerPortal = document.createElement("div");
    const innerHandle = document.createElement("button");
    innerContainer.className = "bn-container";
    innerPortal.className = "bn-root";
    innerPortal.appendChild(innerHandle);
    innerContainer.append(inner.editor, innerPortal);
    outer.block.appendChild(innerContainer);
    document.body.appendChild(outer.editor);

    const outerOwner = BlockNoteEditor.create();
    const innerOwner = BlockNoteEditor.create();
    const unregisterOuter = outerOwner.registerInteractionRoot(outer.editor);
    const unregisterInnerContent = innerOwner.registerInteractionRoot(inner.editor);
    const unregisterInnerPortal = innerOwner.registerInteractionRoot(innerPortal);
    const restoreElementsFromPoint = installElementsFromPoint(document, () => [
      inner.block,
      outer.block,
    ]);
    const outerRuntime = makeSideMenuView(outer, document, outerOwner.getInteractionOwnership);
    const innerRuntime = makeSideMenuView(inner, document, innerOwner.getInteractionOwnership);

    const contentPath = [
      inner.block,
      inner.blockGroup,
      inner.editor,
      innerContainer,
      outer.block,
      outer.blockGroup,
      outer.editor,
      document.body,
      document,
      window,
    ];
    const portalPath = [
      innerHandle,
      innerPortal,
      innerContainer,
      outer.block,
      outer.blockGroup,
      outer.editor,
      document.body,
      document,
      window,
    ];

    try {
      const contentMove = makePointerEvent(
        "mousemove",
        inner.block,
        contentPath,
        160,
        160,
      ) as MouseEvent;
      innerRuntime.view.onMouseMove(contentMove);
      outerRuntime.view.onMouseMove(contentMove);

      expect(innerRuntime.getHoveredBlockId()).toBe("inner");
      expect(innerRuntime.isVisible()).toBe(true);
      expect(outerRuntime.isVisible()).toBe(false);

      const handleMove = makePointerEvent(
        "mousemove",
        innerHandle,
        portalPath,
        100,
        160,
      ) as MouseEvent;
      innerRuntime.view.onMouseMove(handleMove);
      outerRuntime.view.onMouseMove(handleMove);

      expect(innerRuntime.isVisible()).toBe(true);
      expect(outerRuntime.isVisible()).toBe(false);

      const innerDropContext = innerRuntime.view.getDragEventContext(
        makePointerEvent("dragover", inner.block, contentPath, 160, 160) as DragEvent,
      );
      const outerDropContext = outerRuntime.view.getDragEventContext(
        makePointerEvent("dragover", inner.block, contentPath, 160, 160) as DragEvent,
      );

      expect(innerDropContext).toMatchObject({
        isDropPoint: true,
        isDropWithinEditorBounds: true,
      });
      expect(outerDropContext).toBeUndefined();
    } finally {
      innerRuntime.view.destroy();
      outerRuntime.view.destroy();
      restoreElementsFromPoint();
      unregisterInnerPortal();
      unregisterInnerContent();
      unregisterOuter();
      outer.editor.remove();
    }
  });

  test("ignores an editor made inert outside its ShadowRoot", () => {
    const rect = new DOMRect(100, 100, 300, 300);
    const host = document.createElement("div");
    host.setAttribute("inert", "");
    const root = host.attachShadow({ mode: "open" });
    const active = makeEditorCandidate("shadowed", rect);
    root.appendChild(active.editor);
    document.body.appendChild(host);
    const runtime = makeSideMenuView(active, root);

    try {
      runtime.view.onMouseMove(new MouseEvent("mousemove", { clientX: 150, clientY: 150 }));
      const dragContext = runtime.view.getDragEventContext(makeDropEvent("dragover", 150, 150));

      expect(runtime.getHoveredBlockId()).toBe("");
      expect(dragContext).toBeUndefined();
    } finally {
      runtime.view.destroy();
      host.remove();
    }
  });

  test("sets pending dropped ids before dispatching a synthetic gutter drop", () => {
    const editorElement = document.createElement("div");
    const blockGroup = document.createElement("div");
    editorElement.className = "bn-editor";
    blockGroup.className = "bn-block-group";
    editorElement.appendChild(blockGroup);
    document.body.appendChild(editorElement);
    setRect(blockGroup, new DOMRect(100, 100, 300, 300));

    const droppedSlice = new Slice(Fragment.from(makeBlock("b")), 0, 0);
    const pmView: {
      dom: HTMLDivElement;
      root: Document;
      dragging: { slice: Slice; move: boolean } | null;
      dispatch: () => void;
    } = {
      dom: editorElement,
      root: document,
      dragging: {
        slice: droppedSlice,
        move: true,
      },
      dispatch: () => {
        throw new Error("outer drop handler should not collapse selection after synthetic drop");
      },
    };
    let pendingIds = "";
    let pendingIdsSeenBySyntheticDrop = "";
    editorElement.addEventListener("drop", () => {
      pendingIdsSeenBySyntheticDrop = pendingIds;
      pmView.dragging = null;
    });

    const view = new SideMenuView(
      {
        isEditable: true,
        getInteractionOwnership: () => "none",
      } as never,
      pmView as never,
      () => {},
      () => {},
      (blockIds) => {
        pendingIds = blockIds.join(",");
      },
    );

    try {
      view.onDrop(makeDropEvent("drop", 90, 120));

      expect(pendingIdsSeenBySyntheticDrop).toBe("b");
      expect(pendingIds).toBe("b");
      expect(pmView.dragging).toBe(null);
    } finally {
      view.destroy();
      editorElement.remove();
    }
  });

  test("leaves externally managed cross-surface drops to the domain coordinator", () => {
    const editorElement = document.createElement("div");
    const blockGroup = document.createElement("div");
    editorElement.className = "bn-editor";
    blockGroup.className = "bn-block-group";
    editorElement.appendChild(blockGroup);
    document.body.appendChild(editorElement);
    const droppedSlice = new Slice(Fragment.from(makeBlock("managed")), 0, 0);
    const dispatch = vi.fn();
    const pmView = {
      dom: editorElement,
      root: document,
      dragging: { slice: droppedSlice, move: true },
      dispatch,
    };
    const pendingIds = vi.fn();
    const view = new SideMenuView(
      {
        isEditable: true,
        getInteractionOwnership: () => "self",
      } as never,
      pmView as never,
      () => {},
      () => {},
      pendingIds,
      () => true,
    );

    try {
      view.onDrop(makeDropEvent("drop", 120, 120));
      expect(dispatch).not.toHaveBeenCalled();
      expect(pendingIds).toHaveBeenLastCalledWith([]);
      expect(pmView.dragging).not.toBeNull();
    } finally {
      view.destroy();
      editorElement.remove();
    }
  });

  test("replaces ProseMirror single-node drop selection with a non-draggable block range", () => {
    const editorElement = document.createElement("div");
    const blockGroup = document.createElement("div");
    editorElement.className = "bn-editor";
    blockGroup.className = "bn-block-group";
    editorElement.appendChild(blockGroup);
    document.body.appendChild(editorElement);
    setRect(blockGroup, new DOMRect(100, 100, 300, 300));

    const droppedSlice = new Slice(Fragment.from(makeBlock("b")), 0, 0);
    const pmView: {
      dom: HTMLDivElement;
      root: Document;
      dragging: { slice: Slice; move: boolean } | null;
      dispatch: () => void;
    } = {
      dom: editorElement,
      root: document,
      dragging: {
        slice: droppedSlice,
        move: true,
      },
      dispatch: () => {},
    };
    let blurred = false;
    const extension = SideMenuExtension()({
      editor: {
        isEditable: true,
        getInteractionOwnership: () => "none",
        prosemirrorView: pmView,
        blur: () => {
          blurred = true;
        },
      },
    } as never);
    const plugin = extension.prosemirrorPlugins[0];
    const pluginView = plugin.spec.view?.(pmView as never);
    const doc = makeDoc();
    const prosemirrorDropSelection = NodeSelection.create(doc, 4);
    const newState = EditorState.create({
      schema,
      doc,
      selection: prosemirrorDropSelection,
    });
    const dropTransaction = newState.tr.setMeta("uiEvent", "drop");

    try {
      (pluginView as SideMenuView<never, never, never>).onDrop(makeDropEvent("drop", 150, 150));

      const appended = plugin.spec.appendTransaction?.([dropTransaction], newState, newState);
      const nextState = appended ? newState.apply(appended) : newState;
      extension.blockDragEnd();
      extension.blockDragEnd();

      expect(appended === undefined).toBe(false);
      expect(nextState.selection instanceof MultipleNodeSelection).toBe(true);
      expect(selectionIds(nextState.selection)).toBe("b");
      expect(blurred).toBe(false);
    } finally {
      pluginView?.destroy?.();
      editorElement.remove();
    }
  });
});
