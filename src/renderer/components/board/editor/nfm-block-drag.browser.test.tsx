import { describe, expect, test } from "vite-plus/test";
import {
  beginLocalBlockDragSession,
  endLocalBlockDragSession,
  encodeBlockTransferDragPayload,
  NODEX_BLOCK_TRANSFER_DRAG_MIME,
  parseBlockTransferDragPayload,
} from "../../workbench/block-transfer/cross-surface-drag";
import { setupBlockTransferDocumentDrop } from "./block-transfer-drop";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteViewRaw } from "@blocknote/react";
import { act, render } from "@testing-library/react";
import { applyRendererThemeForTest, installRendererThemeFixture } from "@/test/renderer-theme";
import { NFM_DROP_CURSOR_OPTIONS } from "./nfm-drop-indicator";
import "@blocknote/shadcn/style.css";
import "../../../globals.css";

describe("block transfer drop", () => {
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
    receivePages: async () => undefined,
  };

  describe("nested Block transfer targets in Chromium", () => {
    test("hands indicator ownership from the parent editor to the sub-editor", () => {
      const outer = document.createElement("div");
      const outerContent = document.createElement("span");
      const inner = document.createElement("div");
      const innerContent = document.createElement("span");
      outer.className = "nfm-editor";
      inner.className = "nfm-editor";
      inner.append(innerContent);
      outer.append(outerContent, inner);
      document.body.append(outer);

      const outerCleanup = setupBlockTransferDocumentDrop(outer, { document: [] }, () => ({
        ...structuralPreparation,
        surfaceId: "surface-outer",
        projectId: "project-a",
        documentId: "document-outer",
        storeEpoch: "epoch-a",
        ancestorPageIds: [],
        createOperationId: () => "operation-outer",
        transfer: async () => {
          throw new Error("The test does not drop");
        },
        reportError: () => undefined,
      }));
      const innerCleanup = setupBlockTransferDocumentDrop(inner, { document: [] }, () => ({
        ...structuralPreparation,
        surfaceId: "surface-inner",
        projectId: "project-a",
        documentId: "document-inner",
        storeEpoch: "epoch-a",
        ancestorPageIds: [],
        createOperationId: () => "operation-inner",
        transfer: async () => {
          throw new Error("The test does not drop");
        },
        reportError: () => undefined,
      }));
      const dataTransfer = new DataTransfer();
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
      const dragOver = (target: Element) => {
        target.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            clientX: 0,
            clientY: 0,
            dataTransfer,
          }),
        );
      };

      try {
        dragOver(outerContent);
        expect(outer.hasAttribute("data-block-transfer-drop-hover")).toBe(true);

        dragOver(innerContent);
        expect(outer.hasAttribute("data-block-transfer-drop-hover")).toBe(false);
        expect(inner.hasAttribute("data-block-transfer-drop-hover")).toBe(true);
        expect(document.querySelectorAll("[data-block-transfer-drop-indicator]")).toHaveLength(1);
      } finally {
        endLocalBlockDragSession();
        innerCleanup();
        outerCleanup();
        outer.remove();
      }
    });
  });
});

describe("nfm drop indicator", () => {
  installRendererThemeFixture();

  const settleEditor = async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.resolve();
  };

  const unexpectedDrop = async (): Promise<never> => {
    throw new Error("This feedback test does not commit a drop");
  };

  test.each(["light", "dark"] as const)(
    "shares editor placement paint without changing cursor orientation in %s",
    async (variant) => {
      applyRendererThemeForTest(variant, {
        accents: { [variant]: { kind: "preset", name: "orange" } },
      });
      let orientation:
        | "block-horizontal"
        | "inline"
        | "block-vertical-left"
        | "block-vertical-right" = "block-horizontal";
      const editor = BlockNoteEditor.create({
        initialContent: [{ id: "first", type: "paragraph", content: "Drag around this Block" }],
        dropCursor: {
          ...NFM_DROP_CURSOR_OPTIONS,
          hooks: {
            computeDropPosition: () => ({ pos: orientation === "inline" ? 3 : 1, orientation }),
          },
        },
      });
      const surface = render(
        <section className="nfm-editor relative" style={{ width: 640 }}>
          <BlockNoteViewRaw
            editor={editor}
            formattingToolbar={false}
            linkToolbar={false}
            slashMenu={false}
            sideMenu={false}
            tableHandles={false}
          />
        </section>,
      );
      let releaseTransferTarget: (() => void) | undefined;

      try {
        await act(settleEditor);
        const container = surface.container.querySelector<HTMLElement>(".nfm-editor");
        const view = editor.prosemirrorView;
        const block = container?.querySelector<HTMLElement>(".bn-block-content");
        if (!container || !view || !block) throw new Error("Expected a mounted editor Block");

        const rect = block.getBoundingClientRect();
        const transfer = new DataTransfer();
        const hover = async () => {
          await act(async () => {
            block.dispatchEvent(
              new DragEvent("dragover", {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + 20,
                clientY: rect.bottom - 2,
                dataTransfer: transfer,
              }),
            );
            await settleEditor();
          });
        };
        const expectPaint = (element: HTMLElement) => {
          const style = getComputedStyle(element);
          expect(style.backgroundColor).toBe(
            variant === "light" ? "rgb(160, 202, 242)" : "rgb(29, 75, 119)",
          );
          expect(style.borderRadius).toBe("999px");
          expect(style.pointerEvents).toBe("none");
        };

        await hover();
        const horizontal = container.querySelector<HTMLElement>(".prosemirror-dropcursor-block");
        if (!horizontal) throw new Error("Expected native horizontal placement feedback");
        expectPaint(horizontal);
        const nativeRect = horizontal.getBoundingClientRect();
        expect(nativeRect.height).toBe(3);
        const rootRect = container
          .querySelector<HTMLElement>(".bn-block-outer")!
          .getBoundingClientRect();
        expect(Math.abs(nativeRect.top + nativeRect.height / 2 - rootRect.top)).toBeLessThan(0.5);

        for (const next of ["inline", "block-vertical-left", "block-vertical-right"] as const) {
          orientation = next;
          await hover();
          const vertical = container.querySelector<HTMLElement>(
            next === "inline"
              ? ".prosemirror-dropcursor-inline"
              : ".prosemirror-dropcursor-vertical",
          );
          if (!vertical) throw new Error(`Expected native ${next} placement feedback`);
          expectPaint(vertical);
          const verticalRect = vertical.getBoundingClientRect();
          expect(verticalRect.width).toBe(3);
          expect(verticalRect.height).toBeGreaterThan(3);
        }

        await act(async () => {
          view.dom.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
          await settleEditor();
        });
        releaseTransferTarget = setupBlockTransferDocumentDrop(
          container,
          { document: editor.document },
          () => ({
            surfaceId: "surface-target",
            projectId: "project-a",
            documentId: "document-target",
            storeEpoch: "epoch-a",
            ancestorPageIds: [],
            prepareAndFence: unexpectedDrop,
            prepareSourceAndFence: unexpectedDrop,
            structuralTransfer: unexpectedDrop,
            receivePages: unexpectedDrop,
            reportError: () => undefined,
          }),
        );
        beginLocalBlockDragSession(
          {
            sourceSurfaceId: "surface-source",
            projectId: "project-a",
            storeEpoch: "epoch-a",
            source: { kind: "document", documentId: "document-source" },
            rootBlockIds: ["source"],
            displayHints: ["paragraph"],
          },
          transfer,
        );
        await hover();
        const received = container.querySelector<HTMLElement>(
          "[data-block-transfer-drop-indicator]",
        );
        if (!received) throw new Error("Expected cross-surface placement feedback");
        expectPaint(received);
        const receivedRect = received.getBoundingClientRect();
        expect(receivedRect.height).toBe(3);
        const rootBottom = container
          .querySelector<HTMLElement>(".bn-block-outer")!
          .getBoundingClientRect().bottom;
        expect(Math.abs(receivedRect.top + receivedRect.height / 2 - rootBottom)).toBeLessThan(0.5);
      } finally {
        endLocalBlockDragSession();
        releaseTransferTarget?.();
        surface.unmount();
        editor._tiptapEditor.destroy();
      }
    },
  );
});

describe("cross-surface Block transfer in Chromium", () => {
  test("preserves the stable-ID payload through a native DataTransfer", () => {
    const transfer = new DataTransfer();
    transfer.setData(
      NODEX_BLOCK_TRANSFER_DRAG_MIME,
      encodeBlockTransferDragPayload({
        sessionId: "session-a",
        sourceSurfaceId: "surface-a",
        projectId: "project-a",
        storeEpoch: "epoch-a",
        source: { kind: "document", documentId: "document-a" },
        rootBlockIds: ["block-a"],
        displayHints: ["paragraph"],
      }),
    );

    expect(
      parseBlockTransferDragPayload(transfer.getData(NODEX_BLOCK_TRANSFER_DRAG_MIME)),
    ).toMatchObject({ rootBlockIds: ["block-a"] });
  });
});
