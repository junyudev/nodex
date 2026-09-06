import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import {
  prepareNfmEditorForMutation,
  prepareNfmEditorStructuralMutation,
  runNfmEditorFocusPreservingMutation,
  type NfmEditorMutationRuntime,
} from "./nfm-editor-relocation";

describe("NfmEditor mutation preparation", () => {
  test("fences a retained Document without touching an unmounted editor view", async () => {
    const head = {
      documentId: "retained-document",
      storeEpoch: "epoch",
      generation: 1,
      expectedHeadSeq: 8,
    };
    const flushAndFence = vi.fn(async () => head);
    const editor = {
      get prosemirrorView(): never {
        throw new Error("Detached editor has no view");
      },
      getExtension: () => {
        throw new Error("Detached editor has no drag state");
      },
    };
    const cancellation = new AbortController();
    const options = { signal: cancellation.signal, deadlineAt: Date.now() + 1_000 };
    expect(
      await prepareNfmEditorStructuralMutation(editor, null, { flushAndFence }, options),
    ).toEqual(head);
    expect(flushAndFence).toHaveBeenCalledWith(options);
    cancellation.abort();
    await expect(
      prepareNfmEditorStructuralMutation(editor, null, { flushAndFence }, options),
    ).rejects.toThrow();
    expect(flushAndFence).toHaveBeenCalledTimes(1);
  });

  test("blurs only its own editor and waits for the DOM boundary", async () => {
    const view = render(
      <>
        <div data-testid="surface-editor">
          <div contentEditable data-testid="editor-content" />
        </div>
        <input aria-label="Other surface" />
      </>,
    );
    const container = view.getByTestId("surface-editor");
    const content = view.getByTestId("editor-content");
    const other = view.getByRole("textbox", {
      name: "Other surface",
    }) as HTMLInputElement;
    let blurCalls = 0;
    const runtime: NfmEditorMutationRuntime = {
      isFocused: () => content.ownerDocument.activeElement === content,
      isWithinEditor: (element) => container.contains(element),
      blur: () => {
        blurCalls += 1;
        content.blur();
      },
    };

    content.focus();
    await prepareNfmEditorForMutation(runtime, container);
    expect(blurCalls).toBe(1);
    expect(content.ownerDocument.activeElement === content).toBe(false);
    other.focus();
    await prepareNfmEditorForMutation(runtime, container);
    expect(other.ownerDocument.activeElement === other).toBe(true);
    expect(blurCalls).toBe(1);
  });

  test("finishes native drag state before flushing the structural head", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const order: string[] = [];
    const editor = {
      prosemirrorView: {
        dragging: { slice: "dragged" },
        root: document,
      },
      getExtension: () => ({
        blockDragEnd: () => {
          order.push("drag-end");
        },
      }),
      blur: () => {
        order.push("blur");
      },
      isFocused: () => true,
    };
    const flushAndFence = vi.fn(async () => {
      order.push("flush");
      return {
        documentId: "document-1",
        storeEpoch: "epoch-1",
        generation: 1,
        expectedHeadSeq: 4,
      };
    });

    try {
      const fence = await prepareNfmEditorStructuralMutation(editor, container, { flushAndFence });

      expect(editor.prosemirrorView.dragging).toBeNull();
      expect(order).toEqual(["drag-end", "blur", "flush"]);
      expect(fence.expectedHeadSeq).toBe(4);
    } finally {
      container.remove();
    }
  });

  test("restores its initiating focus after mutation without stealing a later focus choice", async () => {
    const view = render(
      <>
        <div data-testid="surface-editor">
          <div contentEditable data-testid="editor-content" />
        </div>
        <input aria-label="Other surface" />
      </>,
    );
    const container = view.getByTestId("surface-editor");
    const content = view.getByTestId("editor-content");
    const other = view.getByRole("textbox", {
      name: "Other surface",
    }) as HTMLInputElement;
    const editor: NfmEditorMutationRuntime = {
      isFocused: () => content.ownerDocument.activeElement === content,
      isWithinEditor: (element) => container.contains(element),
      blur: () => content.blur(),
      focus: () => content.focus(),
    };

    content.focus();
    await runNfmEditorFocusPreservingMutation(editor, container, async () => {
      await prepareNfmEditorForMutation(editor, container);
      expect(editor.isFocused?.()).toBe(false);
    });
    expect(content.ownerDocument.activeElement).toBe(content);

    await runNfmEditorFocusPreservingMutation(editor, container, async () => {
      await prepareNfmEditorForMutation(editor, container);
      other.focus();
    });
    expect(content.ownerDocument.activeElement).toBe(other);
  });
});
