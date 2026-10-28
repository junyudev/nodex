import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteViewRaw } from "@blocknote/react";
import { act, render } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import {
  beginLocalBlockDragSession,
  endLocalBlockDragSession,
} from "../../workbench/block-transfer/cross-surface-drag";
import { applyRendererThemeForTest, installRendererThemeFixture } from "@/test/renderer-theme";
import { setupBlockTransferDocumentDrop } from "./block-transfer-drop";
import { NFM_DROP_CURSOR_OPTIONS } from "./nfm-drop-indicator";

import "@blocknote/shadcn/style.css";
import "../../../globals.css";

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
    applyRendererThemeForTest(variant, { accent: { kind: "preset", name: "orange" } });
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
          next === "inline" ? ".prosemirror-dropcursor-inline" : ".prosemirror-dropcursor-vertical",
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
      const received = container.querySelector<HTMLElement>("[data-block-transfer-drop-indicator]");
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
