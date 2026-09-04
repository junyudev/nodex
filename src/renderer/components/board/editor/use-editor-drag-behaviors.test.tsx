import { describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { DropCursorExtension, SideMenuExtension } from "@blocknote/core/extensions";
import { render, settleAsyncRender } from "@/test/dom";
import type { BlockTransferDropBoundary } from "./block-transfer-drop";
import { useEditorDragBehaviors } from "./use-editor-drag-behaviors";
import {
  beginLocalBlockDragSession,
  endLocalBlockDragSession,
  shouldHandleNativeCrossSurfaceDrag,
} from "../../workbench/block-transfer/cross-surface-drag";

type DragBehaviorEditor = Parameters<typeof useEditorDragBehaviors>[0]["editor"];

function makeEditor(
  onBlockDragEnd: () => void,
  onExternalDragOwnershipResolver?: (
    extension: unknown,
    resolver: (event: DragEvent) => boolean,
  ) => void,
): DragBehaviorEditor {
  const block = { id: "block-1", type: "paragraph", content: [{ type: "text", text: "Block" }] };
  return {
    document: [block],
    prosemirrorView: {
      dragging: { id: "active-drag" },
      state: { selection: {} },
      root: {
        querySelectorAll: () => [],
      },
    },
    getBlock: (id: string) => (id === block.id ? block : undefined),
    getParentBlock: () => undefined,
    getSelection: () => ({ blocks: [block] }),
    removeBlocks: () => undefined,
    replaceBlocks: () => undefined,
    transact: <T,>(fn: () => T) => fn(),
    getExtension: (extension: unknown) => ({
      blockDragEnd: onBlockDragEnd,
      setExternalDragOwnershipResolver: (resolver: (event: DragEvent) => boolean) => {
        onExternalDragOwnershipResolver?.(extension, resolver);
        return () => undefined;
      },
    }),
    insertBlocks: () => undefined,
  } as unknown as DragBehaviorEditor;
}

function DragBehaviorHarness({
  editor,
  containerRef,
  crossSurface = false,
  dropBoundary,
}: {
  editor: DragBehaviorEditor;
  containerRef: RefObject<HTMLDivElement | null>;
  crossSurface?: boolean;
  dropBoundary?: Partial<BlockTransferDropBoundary>;
}) {
  useEditorDragBehaviors({
    editor,
    containerRef,
    ...(crossSurface
      ? {
          crossSurface: {
            surfaceId: "surface-a",
            projectId: "project-a",
            documentId: "document-a",
            storeEpoch: "epoch-a",
            blockTransferDrop: {
              surfaceId: "surface-a",
              projectId: "project-a",
              documentId: "document-a",
              storeEpoch: "epoch-a",
              hostPageId: "card-host",
              ancestorPageIds: [],
              prepareAndFence: async () => ({
                documentId: "document-a",
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
              createOperationId: () => "operation-a",
              transfer: async () => ({
                ok: false,
                error: {
                  code: "unknown",
                  message: "not used",
                  retryable: false,
                  reloadRequired: false,
                },
              }),
              structuralTransfer: async () => undefined,
              reportError: () => undefined,
              ...dropBoundary,
            },
          },
        }
      : {}),
  });
  return <div ref={containerRef} data-testid="editor-container" />;
}

describe("useEditorDragBehaviors", () => {
  test("keeps a dropped transfer waiting across rebinding and cancels it only on teardown", async () => {
    const editor = makeEditor(() => undefined);
    const containerRef = createRef<HTMLDivElement>();
    const pending: Array<{
      signal: AbortSignal;
      finish: () => void;
    }> = [];
    const prepareAndFence: BlockTransferDropBoundary["prepareAndFence"] = (options) =>
      new Promise((resolve) => {
        pending.push({
          signal: options!.signal!,
          finish: () =>
            resolve({
              documentId: "document-a",
              storeEpoch: "epoch-a",
              generation: 1,
              expectedHeadSeq: 3,
            }),
        });
      });
    const transfer = vi.fn(async () => undefined);
    const nextTransfer = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const view = render(
      <DragBehaviorHarness
        editor={editor}
        containerRef={containerRef}
        crossSurface
        dropBoundary={{ prepareAndFence, structuralTransfer: transfer, reportError }}
      />,
    );
    await settleAsyncRender();
    const container = view.getByTestId("editor-container");
    container.classList.add("nfm-editor");
    const drop = async () => {
      const values = new Map<string, string>();
      const dataTransfer = {
        get types() {
          return [...values.keys()];
        },
        effectAllowed: "uninitialized",
        setData: (type: string, value: string) => values.set(type, value),
        getData: (type: string) => values.get(type) ?? "",
      } as unknown as DataTransfer;
      beginLocalBlockDragSession(
        {
          sourceSurfaceId: "surface-b",
          projectId: "project-a",
          storeEpoch: "epoch-a",
          source: { kind: "document", documentId: "document-b" },
          rootBlockIds: ["block-b"],
          displayHints: ["paragraph"],
        },
        dataTransfer,
      );
      await act(async () => {
        fireEvent.drop(container, { dataTransfer, clientX: 0, clientY: 0 });
        await Promise.resolve();
      });
    };
    try {
      await drop();
      await waitFor(() => expect(pending).toHaveLength(1));
      view.rerender(
        <DragBehaviorHarness
          editor={editor}
          containerRef={containerRef}
          crossSurface
          dropBoundary={{ prepareAndFence, structuralTransfer: nextTransfer, reportError }}
        />,
      );
      await settleAsyncRender();
      expect(pending[0]!.signal.aborted).toBe(false);
      await act(async () => {
        pending[0]!.finish();
        await Promise.resolve();
      });
      await waitFor(() => expect(transfer).toHaveBeenCalledOnce());
      expect(reportError).not.toHaveBeenCalled();

      await drop();
      await waitFor(() => expect(pending).toHaveLength(2));
      await act(async () => {
        pending[1]!.finish();
        await Promise.resolve();
      });
      await waitFor(() => expect(nextTransfer).toHaveBeenCalledOnce());

      await drop();
      await waitFor(() => expect(pending).toHaveLength(3));
      view.unmount();
      await settleAsyncRender();
      expect(pending[2]!.signal.aborted).toBe(true);
      expect(nextTransfer).toHaveBeenCalledOnce();
      await waitFor(() =>
        expect(reportError).toHaveBeenCalledWith("The structural edit was cancelled."),
      );
    } finally {
      endLocalBlockDragSession();
      view.unmount();
    }
  });

  test("keeps side-menu drag state across ordinary editor rerenders", async () => {
    let blockDragEndCount = 0;
    const editor = makeEditor(() => {
      blockDragEndCount += 1;
    });
    const containerRef = createRef<HTMLDivElement>();

    const view = render(<DragBehaviorHarness editor={editor} containerRef={containerRef} />);
    await settleAsyncRender();

    const container = view.getByTestId("editor-container");
    await act(async () => {
      fireEvent.dragStart(container);
      await Promise.resolve();
    });

    view.rerender(<DragBehaviorHarness editor={editor} containerRef={containerRef} />);
    await settleAsyncRender();

    expect(editor.prosemirrorView?.dragging === null).toBe(false);
    expect(blockDragEndCount).toBe(0);

    await act(async () => {
      fireEvent.dragEnd(container);
      await Promise.resolve();
    });

    expect(editor.prosemirrorView?.dragging).toBe(null);
    expect(blockDragEndCount).toBe(1);
  });

  test("does not infer a managed Block session from an arbitrary container drag", async () => {
    const editor = makeEditor(() => undefined);
    const containerRef = createRef<HTMLDivElement>();
    const view = render(
      <DragBehaviorHarness editor={editor} containerRef={containerRef} crossSurface />,
    );
    await settleAsyncRender();
    const container = view.getByTestId("editor-container");
    container.classList.add("nfm-editor");
    const types: string[] = [];
    const dataTransfer = {
      types,
      effectAllowed: "uninitialized",
      setData: (type: string, value: string) => {
        void value;
        if (!types.includes(type)) types.push(type);
      },
    } as unknown as DataTransfer;
    const dragStart = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });

    await act(async () => {
      container.dispatchEvent(dragStart);
      await Promise.resolve();
    });

    expect(types).toEqual([]);
    expect(dataTransfer.effectAllowed).toBe("uninitialized");
    expect(shouldHandleNativeCrossSurfaceDrag(dataTransfer)).toBe(false);

    await act(async () => {
      fireEvent.dragEnd(container);
      await Promise.resolve();
    });
    expect(shouldHandleNativeCrossSurfaceDrag(dataTransfer)).toBe(false);
  });

  test("makes both BlockNote native drag paths yield to a cross-surface session", async () => {
    const resolvers = new Map<unknown, (event: DragEvent) => boolean>();
    const editor = makeEditor(
      () => undefined,
      (extension, resolver) => resolvers.set(extension, resolver),
    );
    const containerRef = createRef<HTMLDivElement>();
    const view = render(
      <DragBehaviorHarness editor={editor} containerRef={containerRef} crossSurface />,
    );
    await settleAsyncRender();
    const container = view.getByTestId("editor-container");
    container.classList.add("nfm-editor");
    const types: string[] = [];
    const values = new Map<string, string>();
    const dataTransfer = {
      types,
      effectAllowed: "uninitialized",
      setData: (type: string, value: string) => {
        if (!types.includes(type)) types.push(type);
        values.set(type, value);
      },
      getData: (type: string) => values.get(type) ?? "",
    } as unknown as DataTransfer;
    beginLocalBlockDragSession(
      {
        sourceSurfaceId: "surface-b",
        projectId: "project-a",
        storeEpoch: "epoch-a",
        source: { kind: "document", documentId: "document-b" },
        rootBlockIds: ["block-b"],
        displayHints: ["paragraph"],
      },
      dataTransfer,
    );
    const dragOver = new Event("dragover", {
      bubbles: true,
      cancelable: true,
    }) as DragEvent;
    Object.defineProperties(dragOver, {
      dataTransfer: { value: dataTransfer },
      target: { value: container },
    });

    try {
      expect(resolvers.get(SideMenuExtension)?.(dragOver)).toBe(true);
      expect(resolvers.get(DropCursorExtension)?.(dragOver)).toBe(true);
    } finally {
      endLocalBlockDragSession();
    }
  });
});
