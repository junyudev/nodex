import { describe, expect, test, vi } from "vite-plus/test";
import type { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  isSameDocumentBlockTargetInsideSelection,
  isSameDocumentBlockMoveNoOp,
  resolveBlockTransferDocumentTarget,
  setupBlockTransferDocumentDrop,
  type BlockTransferDropEditor,
} from "./block-transfer-drop";
import type { PublicBlockTransferIntent } from "../../../../shared/block-transfer-transport";
import type { BoardCardDragData } from "../pragmatic-drag-data";
import {
  beginLocalBlockDragSession,
  endLocalBlockDragSession,
} from "../../workbench/block-transfer/cross-surface-drag";

type ElementDropTargetArgs = Parameters<typeof dropTargetForElements>[0];

const dropTargetHarness = vi.hoisted(() => ({
  registration: null as unknown,
  registrations: [] as unknown[],
}));

vi.mock("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  dropTargetForElements: (args: unknown) => {
    dropTargetHarness.registration = args;
    dropTargetHarness.registrations.push(args);
    return () => undefined;
  },
}));

const dragData = {
  type: "board-card",
  instanceId: Symbol("board"),
  projectId: "project-a",
  databaseBlockId: "database-a",
  dataSourceId: "source-a",
  storeEpoch: "epoch-a",
  sourcePageId: "card-target",
  sourceColumnId: "triage",
  sourcePage: { id: "card-target", title: "Target" },
  dragItems: [
    {
      card: { id: "card-target", title: "Target" },
      columnId: "triage",
      columnName: "Triage",
    },
  ],
} as unknown as BoardCardDragData;

const input = (altKey: boolean) => ({
  clientX: 0,
  clientY: 0,
  altKey,
  button: 0,
  buttons: 1,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
});

const structuralPreparation = {
  prepareAndFence: async () => ({
    documentId: "document-target",
    storeEpoch: "epoch-a",
    generation: 1,
    expectedHeadSeq: 0,
  }),
  prepareSourceAndFence: async () => ({
    documentId: "document-source",
    storeEpoch: "epoch-a",
    generation: 1,
    expectedHeadSeq: 0,
  }),
  structuralTransfer: async () => undefined,
};

describe("Board Card Block transfer drop", () => {
  test("resolves before/after against the target Block hierarchy", () => {
    const editor: BlockTransferDropEditor = {
      document: [
        {
          id: "parent",
          children: [{ id: "first" }, { id: "second" }],
        },
        { id: "tail" },
      ],
    };
    expect(
      resolveBlockTransferDocumentTarget(editor, {
        blockId: "first",
        placement: "after",
      }),
    ).toEqual({ parentBlockId: "parent", beforeBlockId: "second" });
    expect(
      resolveBlockTransferDocumentTarget(editor, {
        blockId: "second",
        placement: "after",
      }),
    ).toEqual({ parentBlockId: "parent" });
  });

  test("recognizes same-Document subtree move no-ops without hiding real reorders", () => {
    const editor: BlockTransferDropEditor = {
      document: [
        { id: "before" },
        { id: "1111", children: [{ id: "222" }] },
        { id: "middle" },
        { id: "3333" },
      ],
    };

    expect(
      isSameDocumentBlockMoveNoOp(editor, ["1111"], {
        beforeBlockId: "middle",
      }),
    ).toBe(true);
    expect(
      isSameDocumentBlockMoveNoOp(editor, ["1111"], {
        parentBlockId: "1111",
      }),
    ).toBe(true);
    expect(isSameDocumentBlockMoveNoOp(editor, ["1111"], {})).toBe(false);
    expect(
      isSameDocumentBlockTargetInsideSelection(editor, ["1111"], {
        parentBlockId: "222",
      }),
    ).toBe(true);
  });

  test.each([
    [false, "move"],
    [true, "copy"],
  ] as const)(
    "uses one collapsed-toggle target for feedback and structural commit (alt=%s)",
    async (altKey, mode) => {
      const container = document.createElement("div");
      container.className = "nfm-editor";
      const outer = document.createElement("div");
      outer.className = "bn-block-outer";
      const block = document.createElement("div");
      block.className = "bn-block";
      block.dataset.id = "toggle";
      const content = document.createElement("div");
      content.className = "bn-block-content";
      const wrapper = document.createElement("div");
      wrapper.className = "bn-toggle-wrapper";
      wrapper.dataset.showChildren = "false";
      content.append(wrapper);
      block.append(content);
      outer.append(block);
      container.append(outer);
      document.body.append(container);

      const headerRect = {
        x: 40,
        y: 100,
        top: 100,
        right: 360,
        bottom: 140,
        left: 40,
        width: 320,
        height: 40,
        toJSON: () => undefined,
      };
      Object.defineProperties(content, { getBoundingClientRect: { value: () => headerRect } });
      Object.defineProperties(block, { getBoundingClientRect: { value: () => headerRect } });
      Object.defineProperties(container, {
        getBoundingClientRect: {
          value: () => ({ ...headerRect, x: 0, y: 0, top: 0, left: 0 }),
        },
      });
      const previousElementsFromPoint = Object.getOwnPropertyDescriptor(
        document,
        "elementsFromPoint",
      );
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: () => [wrapper],
      });

      const transfer = vi.fn();
      const structuralTransfer = vi.fn(async () => undefined);
      const cleanup = setupBlockTransferDocumentDrop(
        container,
        {
          document: [
            { id: "toggle", type: "toggleListItem", children: [] },
            { id: "source", type: "paragraph" },
            { id: "page", type: "page" },
          ],
        },
        {
          ...structuralPreparation,
          surfaceId: "surface-page",
          projectId: "project-a",
          documentId: "document-target",
          storeEpoch: "epoch-a",
          hostPageId: "page-1",
          ancestorPageIds: [],
          createOperationId: () => "operation-toggle",
          transfer,
          structuralTransfer,
          reportError: vi.fn(),
        },
      );
      const values = new Map<string, string>();
      const types: string[] = [];
      const dataTransfer = {
        types,
        effectAllowed: "uninitialized",
        dropEffect: "none",
        setData: (type: string, value: string) => {
          if (!types.includes(type)) types.push(type);
          values.set(type, value);
        },
        getData: (type: string) => values.get(type) ?? "",
      } as unknown as DataTransfer;
      beginLocalBlockDragSession(
        {
          sourceSurfaceId: "surface-page",
          projectId: "project-a",
          storeEpoch: "epoch-a",
          source: { kind: "page", pageId: "page-1" },
          rootBlockIds: ["source", "page"],
          displayHints: ["paragraph", "page"],
        },
        dataTransfer,
      );
      const dispatchDrag = (type: "dragover" | "drop", clientY: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          dataTransfer: { value: dataTransfer },
          clientX: { value: 120 },
          clientY: { value: clientY },
          altKey: { value: altKey },
        });
        container.dispatchEvent(event);
        return event;
      };

      try {
        dispatchDrag("dragover", 120);
        expect(container.hasAttribute("data-toggle-drop-active")).toBe(true);
        expect(container.querySelectorAll("[data-toggle-drop-overlay]")).toHaveLength(1);
        expect(container.querySelectorAll("[data-block-transfer-drop-indicator]")).toHaveLength(0);

        dispatchDrag("dragover", 102);
        expect(container.hasAttribute("data-toggle-drop-active")).toBe(false);
        expect(container.querySelectorAll("[data-toggle-drop-overlay]")).toHaveLength(0);
        expect(container.querySelectorAll("[data-block-transfer-drop-indicator]")).toHaveLength(1);

        dispatchDrag("dragover", 120);
        const drop = dispatchDrag("drop", 120);
        await vi.waitFor(() => expect(structuralTransfer).toHaveBeenCalledOnce());
        expect(drop.defaultPrevented).toBe(true);
        expect(transfer).not.toHaveBeenCalled();
        expect(structuralTransfer).toHaveBeenCalledWith({
          mode,
          rootBlockIds: ["source", "page"],
          sourceHead: expect.objectContaining({ documentId: "document-target" }),
          targetHead: expect.objectContaining({ documentId: "document-target" }),
          target: { parentBlockId: "toggle", beforeBlockId: null },
          preferredSelectionBlockId: "toggle",
        });
        expect(container.querySelectorAll("[data-toggle-drop-overlay]")).toHaveLength(0);
      } finally {
        cleanup();
        endLocalBlockDragSession();
        if (previousElementsFromPoint) {
          Object.defineProperty(document, "elementsFromPoint", previousElementsFromPoint);
        } else {
          Reflect.deleteProperty(document, "elementsFromPoint");
        }
        container.remove();
      }
    },
  );

  test("removes active drop feedback when the target is replaced", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const cleanup = setupBlockTransferDocumentDrop(
      container,
      { document: [] },
      {
        ...structuralPreparation,
        surfaceId: "surface-target",
        projectId: "project-a",
        documentId: "document-host",
        storeEpoch: "epoch-a",
        ancestorPageIds: [],
        createOperationId: () => "operation-a",
        transfer: async () => {
          throw new Error("The test does not drop");
        },
        reportError: vi.fn(),
      },
    );
    const registration = dropTargetHarness.registration as ElementDropTargetArgs;
    const self = { element: container, data: {}, dropEffect: "move" as const };
    registration.onDrag?.({
      source: { data: dragData },
      location: {
        current: { input: input(false), dropTargets: [self] },
      },
      self,
    } as unknown as Parameters<NonNullable<ElementDropTargetArgs["onDrag"]>>[0]);

    expect(container.hasAttribute("data-block-transfer-drop-hover")).toBe(true);
    expect(container.querySelectorAll("[data-block-transfer-drop-indicator]")).toHaveLength(1);

    cleanup();

    expect(container.hasAttribute("data-block-transfer-drop-hover")).toBe(false);
    expect(container.querySelectorAll("[data-block-transfer-drop-indicator]")).toHaveLength(0);
    container.remove();
  });

  test.each([
    [false, "move"],
    [true, "copy"],
  ] as const)("submits one authority intent at drop time (alt=%s)", async (altKey, mode) => {
    const container = document.createElement("div");
    const transfer = vi.fn(async (...args: [PublicBlockTransferIntent]) => {
      void args;
      return {
        ok: true as const,
        localCommit: {
          status: "no_op" as const,
          observed: { store_epoch: "epoch-a", commit_head: 1 },
        },
        value: {
          version: 3 as const,
          operationId: "operation-a",
          projectId: "project-a",
          storeEpoch: "epoch-a",
          mode,
          duplicate: false,
          sourceRootBlockIds: ["card-target"],
          resultRootBlockIds: ["card-target"],
          copiedBlockIds: {},
          transformationEvidence: [],
          finalLocations: {
            "card-target": {
              kind: "document" as const,
              documentId: "document-host",
            },
          },
          finalLocationRevisions: { "card-target": 2 },
          documentCommits: [],
          affectedDatabaseBlockIds: ["database-a"],
          fileOwnershipMoves: [],
          commitSeq: 1,
          committedAt: "2026-07-13T00:00:00.000Z",
          undoToken: null,
        },
      };
    });
    const cleanup = setupBlockTransferDocumentDrop(
      container,
      { document: [] },
      {
        ...structuralPreparation,
        surfaceId: "surface-target",
        projectId: "project-a",
        documentId: "document-host",
        storeEpoch: "epoch-a",
        hostPageId: "card-host",
        ancestorPageIds: [],
        createOperationId: () => "operation-a",
        transfer,
        reportError: vi.fn(),
      },
    );
    const registration = dropTargetHarness.registration as ElementDropTargetArgs;
    const self = { element: container, data: {}, dropEffect: mode };
    const event = {
      source: { data: dragData },
      location: {
        current: { input: input(altKey), dropTargets: [self] },
      },
      self,
    } as unknown as Parameters<NonNullable<ElementDropTargetArgs["onDrop"]>>[0];

    expect(
      registration.canDrop?.({
        source: { data: dragData },
        input: event.location.current.input,
        element: container,
      } as never),
    ).toBe(true);
    registration.onDrop?.(event);
    await vi.waitFor(() => expect(transfer).toHaveBeenCalledOnce());
    expect(transfer.mock.calls[0]?.[0]).toMatchObject({
      mode,
      rootBlockIds: ["card-target"],
      source: { kind: "data_source", dataSourceId: "source-a" },
      target: { kind: "page", pageId: "card-host" },
    });
    cleanup();
  });

  test("routes every managed editor drag through one structural transfer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const transfer = vi.fn();
    const structuralTransfer = vi.fn(async () => undefined);
    const prepareAndFence = vi.fn(async () => ({
      documentId: "document-target",
      storeEpoch: "epoch-a",
      generation: 1,
      expectedHeadSeq: 0,
    }));
    const prepareSourceAndFence = vi.fn(async () => ({
      documentId: "document-source",
      storeEpoch: "epoch-a",
      generation: 1,
      expectedHeadSeq: 0,
    }));
    const cleanup = setupBlockTransferDocumentDrop(
      container,
      { document: [] },
      {
        surfaceId: "surface-target",
        projectId: "project-a",
        documentId: "document-target",
        storeEpoch: "epoch-a",
        ancestorPageIds: [],
        prepareAndFence,
        prepareSourceAndFence,
        createOperationId: () => "operation-editor",
        transfer,
        structuralTransfer,
        reportError: vi.fn(),
      },
    );
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      types,
      effectAllowed: "uninitialized",
      dropEffect: "none",
      setData: (type: string, value: string) => {
        if (!types.includes(type)) types.push(type);
        values.set(type, value);
      },
      getData: (type: string) => values.get(type) ?? "",
    } as unknown as DataTransfer;
    beginLocalBlockDragSession(
      {
        sourceSurfaceId: "surface-source",
        projectId: "project-a",
        storeEpoch: "epoch-a",
        source: { kind: "document", documentId: "document-source" },
        rootBlockIds: ["block-source"],
        displayHints: ["paragraph"],
      },
      dataTransfer,
    );
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      dataTransfer: { value: dataTransfer },
      clientX: { value: 0 },
      clientY: { value: 0 },
      altKey: { value: true },
    });

    try {
      container.dispatchEvent(drop);
      await vi.waitFor(() => expect(structuralTransfer).toHaveBeenCalledOnce());
      expect(drop.defaultPrevented).toBe(true);
      expect(transfer).not.toHaveBeenCalled();
      expect(structuralTransfer).toHaveBeenCalledWith({
        mode: "copy",
        rootBlockIds: ["block-source"],
        sourceHead: expect.objectContaining({ documentId: "document-source" }),
        targetHead: expect.objectContaining({ documentId: "document-target" }),
        target: { parentBlockId: null, beforeBlockId: null },
      });
      expect(prepareAndFence).toHaveBeenCalledOnce();
      expect(prepareSourceAndFence).toHaveBeenCalledWith("surface-source");
    } finally {
      cleanup();
      endLocalBlockDragSession();
      container.remove();
    }
  });

  test("routes a same-Page Canvas drag through one structural transfer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const transfer = vi.fn();
    const structuralTransfer = vi.fn(async () => undefined);
    const cleanup = setupBlockTransferDocumentDrop(
      container,
      { document: [{ id: "canvas-1" }, { id: "paragraph-1" }] },
      {
        ...structuralPreparation,
        surfaceId: "surface-page",
        projectId: "project-a",
        documentId: "document-page",
        storeEpoch: "epoch-a",
        hostPageId: "page-1",
        ancestorPageIds: [],
        createOperationId: () => "operation-canvas",
        transfer,
        structuralTransfer,
        reportError: vi.fn(),
      },
    );
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      types,
      effectAllowed: "uninitialized",
      dropEffect: "none",
      setData: (type: string, value: string) => {
        if (!types.includes(type)) types.push(type);
        values.set(type, value);
      },
      getData: (type: string) => values.get(type) ?? "",
    } as unknown as DataTransfer;
    beginLocalBlockDragSession(
      {
        sourceSurfaceId: "surface-page",
        projectId: "project-a",
        storeEpoch: "epoch-a",
        source: { kind: "page", pageId: "page-1" },
        rootBlockIds: ["canvas-1"],
        displayHints: ["canvas"],
      },
      dataTransfer,
    );
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      dataTransfer: { value: dataTransfer },
      clientX: { value: 0 },
      clientY: { value: 0 },
      altKey: { value: false },
    });

    try {
      container.dispatchEvent(drop);
      await vi.waitFor(() => expect(structuralTransfer).toHaveBeenCalledOnce());
      expect(drop.defaultPrevented).toBe(true);
      expect(transfer).not.toHaveBeenCalled();
      expect(structuralTransfer).toHaveBeenCalledWith({
        mode: "move",
        rootBlockIds: ["canvas-1"],
        sourceHead: expect.objectContaining({ documentId: "document-target" }),
        targetHead: expect.objectContaining({ documentId: "document-target" }),
        target: { parentBlockId: null, beforeBlockId: null },
      });
    } finally {
      cleanup();
      endLocalBlockDragSession();
      container.remove();
    }
  });

  test("routes an ordinary subtree reorder across typed owners through structural authority", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const transfer = vi.fn();
    const structuralTransfer = vi.fn(async () => undefined);
    const cleanup = setupBlockTransferDocumentDrop(
      container,
      {
        document: [
          { id: "1111", children: [{ id: "222" }] },
          { id: "subpage", children: [] },
          { id: "3333" },
        ],
      },
      {
        ...structuralPreparation,
        surfaceId: "surface-page",
        projectId: "project-a",
        documentId: "document-page",
        storeEpoch: "epoch-a",
        hostPageId: "page-1",
        ancestorPageIds: [],
        createOperationId: () => "operation-subtree",
        transfer,
        structuralTransfer,
        reportError: vi.fn(),
      },
    );
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      types,
      effectAllowed: "uninitialized",
      dropEffect: "none",
      setData: (type: string, value: string) => {
        if (!types.includes(type)) types.push(type);
        values.set(type, value);
      },
      getData: (type: string) => values.get(type) ?? "",
    } as unknown as DataTransfer;
    beginLocalBlockDragSession(
      {
        sourceSurfaceId: "surface-page",
        projectId: "project-a",
        storeEpoch: "epoch-a",
        source: { kind: "page", pageId: "page-1" },
        rootBlockIds: ["1111"],
        displayHints: ["paragraph"],
      },
      dataTransfer,
    );
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      dataTransfer: { value: dataTransfer },
      clientX: { value: 0 },
      clientY: { value: 0 },
      altKey: { value: false },
    });

    try {
      container.dispatchEvent(drop);
      await vi.waitFor(() => expect(structuralTransfer).toHaveBeenCalledOnce());
      expect(drop.defaultPrevented).toBe(true);
      expect(transfer).not.toHaveBeenCalled();
      expect(structuralTransfer).toHaveBeenCalledWith({
        mode: "move",
        rootBlockIds: ["1111"],
        sourceHead: expect.objectContaining({ documentId: "document-target" }),
        targetHead: expect.objectContaining({ documentId: "document-target" }),
        target: { parentBlockId: null, beforeBlockId: null },
      });
    } finally {
      cleanup();
      endLocalBlockDragSession();
      container.remove();
    }
  });

  test("routes a nested editor drop to the deepest semantic surface", async () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    const outerTarget = document.createElement("span");
    const target = document.createElement("span");
    outer.className = "nfm-editor";
    inner.className = "nfm-editor";
    inner.append(target);
    outer.append(outerTarget, inner);
    document.body.append(outer);
    const outerTransfer = vi.fn();
    const outerStructuralTransfer = vi.fn(async () => undefined);
    const clearOuterDropCursor = vi.fn();
    const innerTransfer = vi.fn();
    const innerStructuralTransfer = vi.fn(async () => undefined);
    const outerCleanup = setupBlockTransferDocumentDrop(
      outer,
      {
        document: [],
        getExtension: () => ({ clearDropCursor: clearOuterDropCursor }),
      },
      {
        ...structuralPreparation,
        surfaceId: "surface-outer",
        projectId: "project-a",
        documentId: "document-outer",
        storeEpoch: "epoch-a",
        ancestorPageIds: [],
        createOperationId: () => "operation-outer",
        transfer: outerTransfer,
        structuralTransfer: outerStructuralTransfer,
        reportError: vi.fn(),
      },
    );
    const innerCleanup = setupBlockTransferDocumentDrop(
      inner,
      { document: [] },
      {
        ...structuralPreparation,
        surfaceId: "surface-inner",
        projectId: "project-a",
        documentId: "document-inner",
        storeEpoch: "epoch-a",
        ancestorPageIds: [],
        createOperationId: () => "operation-inner",
        transfer: innerTransfer,
        structuralTransfer: innerStructuralTransfer,
        reportError: vi.fn(),
      },
    );
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      types,
      effectAllowed: "uninitialized",
      dropEffect: "none",
      setData: (type: string, value: string) => {
        if (!types.includes(type)) types.push(type);
        values.set(type, value);
      },
      getData: (type: string) => values.get(type) ?? "",
    } as unknown as DataTransfer;
    beginLocalBlockDragSession(
      {
        sourceSurfaceId: "surface-source",
        projectId: "project-a",
        storeEpoch: "epoch-a",
        source: { kind: "document", documentId: "document-source" },
        rootBlockIds: ["block-source"],
        displayHints: ["paragraph"],
      },
      dataTransfer,
    );
    const dispatchDrag = (type: "dragover" | "drop", element: Element) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        dataTransfer: { value: dataTransfer },
        clientX: { value: 0 },
        clientY: { value: 0 },
        altKey: { value: false },
      });
      element.dispatchEvent(event);
      return event;
    };

    try {
      dispatchDrag("dragover", outerTarget);
      expect(outer.hasAttribute("data-block-transfer-drop-hover")).toBe(true);
      expect(document.querySelectorAll("[data-block-transfer-drop-indicator]")).toHaveLength(1);

      dispatchDrag("dragover", target);
      expect(outer.hasAttribute("data-block-transfer-drop-hover")).toBe(false);
      expect(inner.hasAttribute("data-block-transfer-drop-hover")).toBe(true);
      expect(clearOuterDropCursor).toHaveBeenCalled();
      expect(document.querySelectorAll("[data-block-transfer-drop-indicator]")).toHaveLength(1);

      const drop = dispatchDrag("drop", target);
      await vi.waitFor(() => expect(innerStructuralTransfer).toHaveBeenCalledOnce());
      expect(drop.defaultPrevented).toBe(true);
      expect(outerTransfer).not.toHaveBeenCalled();
      expect(outerStructuralTransfer).not.toHaveBeenCalled();
      expect(innerTransfer).not.toHaveBeenCalled();
      expect(innerStructuralTransfer).toHaveBeenCalledWith({
        mode: "move",
        rootBlockIds: ["block-source"],
        sourceHead: expect.objectContaining({ documentId: "document-source" }),
        targetHead: expect.objectContaining({ documentId: "document-target" }),
        target: { parentBlockId: null, beforeBlockId: null },
      });
    } finally {
      innerCleanup();
      outerCleanup();
      endLocalBlockDragSession();
      outer.remove();
    }
  });

  test("lets only the innermost Pragmatic drop target render and commit", async () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    outer.append(inner);
    document.body.append(outer);
    const outerTransfer = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: "unknown" as const,
        message: "outer must not commit",
        retryable: false,
        reloadRequired: false,
      },
    }));
    const innerTransfer = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: "unknown" as const,
        message: "expected test terminal result",
        retryable: false,
        reloadRequired: false,
      },
    }));
    const registrationStart = dropTargetHarness.registrations.length;
    const outerCleanup = setupBlockTransferDocumentDrop(
      outer,
      { document: [] },
      {
        ...structuralPreparation,
        surfaceId: "surface-outer-pragmatic",
        projectId: "project-a",
        documentId: "document-outer",
        storeEpoch: "epoch-a",
        ancestorPageIds: [],
        createOperationId: () => "operation-outer-pragmatic",
        transfer: outerTransfer,
        reportError: vi.fn(),
      },
    );
    const innerCleanup = setupBlockTransferDocumentDrop(
      inner,
      { document: [] },
      {
        ...structuralPreparation,
        surfaceId: "surface-inner-pragmatic",
        projectId: "project-a",
        documentId: "document-inner",
        storeEpoch: "epoch-a",
        ancestorPageIds: [],
        createOperationId: () => "operation-inner-pragmatic",
        transfer: innerTransfer,
        reportError: vi.fn(),
      },
    );
    const [outerRegistration, innerRegistration] = dropTargetHarness.registrations.slice(
      registrationStart,
    ) as [ElementDropTargetArgs, ElementDropTargetArgs];
    const outerRecord = { element: outer, data: {}, dropEffect: "move" };
    const innerRecord = { element: inner, data: {}, dropEffect: "move" };
    const location = {
      initial: { input: input(false), dropTargets: [] },
      previous: { dropTargets: [] },
      current: {
        input: input(false),
        dropTargets: [innerRecord, outerRecord],
      },
    };
    const eventFor = (self: typeof innerRecord) =>
      ({ source: { data: dragData }, location, self }) as never;

    try {
      innerRegistration.onDrag?.(eventFor(innerRecord));
      outerRegistration.onDrag?.(eventFor(outerRecord));
      expect(outer.hasAttribute("data-block-transfer-drop-hover")).toBe(false);
      expect(inner.hasAttribute("data-block-transfer-drop-hover")).toBe(true);
      expect(document.querySelectorAll("[data-block-transfer-drop-indicator]")).toHaveLength(1);

      innerRegistration.onDrop?.(eventFor(innerRecord));
      outerRegistration.onDrop?.(eventFor(outerRecord));
      await vi.waitFor(() => expect(innerTransfer).toHaveBeenCalledOnce());
      expect(outerTransfer).not.toHaveBeenCalled();
    } finally {
      innerCleanup();
      outerCleanup();
      outer.remove();
    }
  });
});
