import { describe, expect, test } from "vite-plus/test";
import {
  beginLocalBlockDragSession,
  endLocalBlockDragSession,
} from "../../workbench/block-transfer/cross-surface-drag";
import { setupBlockTransferDocumentDrop } from "./block-transfer-drop";

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
