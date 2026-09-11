import { BlockNoteEditor } from "@blocknote/core";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { act } from "@testing-library/react";
import type {
  StructuralRemovalPresentation,
  StructuralRemovalReceipt,
} from "@/lib/block-document-mutation-registry";
import type { HistoryCommandObservation } from "@/lib/surface-history/owner";
import {
  nfmClipboardPastePendingExtension,
  nfmClipboardPastePendingPluginKey,
} from "./nfm-clipboard-paste-pending-extension";
import { NfmStructuralRemovalPresentation } from "./nfm-structural-removal-presentation";

const flush = async (run: () => void) =>
  await act(async () => {
    run();
    await Promise.resolve();
  });

describe("structural source presentation", () => {
  let editor: BlockNoteEditor;
  let detach: (() => void) | undefined;
  afterEach(async () => {
    await flush(() => {
      detach?.();
      editor?._tiptapEditor.destroy();
    });
    document.body.replaceChildren();
  });
  const fixture = async () => {
    editor = BlockNoteEditor.create({
      initialContent: [{ id: "source", type: "paragraph", content: "Keep editable" }],
      extensions: [nfmClipboardPastePendingExtension()],
    });
    const container = document.createElement("div");
    document.body.append(container);
    let headSeq = 1;
    const headListeners = new Set<() => void>();
    const presenter = new NfmStructuralRemovalPresentation({
      editor,
      readHead: () => ({
        documentId: "document",
        storeEpoch: "epoch",
        generation: 1,
        expectedHeadSeq: headSeq,
      }),
      subscribeHead: (listener) => {
        headListeners.add(listener);
        return () => {
          headListeners.delete(listener);
        };
      },
    });
    let releaseView!: () => void;
    await flush(() => {
      editor.mount(container);
      releaseView = presenter.attach();
      detach = () => {
        releaseView();
        presenter.dispose();
      };
    });
    const admission = (operationId: string) => {
      let notify!: (state: HistoryCommandObservation<StructuralRemovalReceipt>) => void;
      const operation: StructuralRemovalPresentation = {
        operationId,
        rootBlockIds: ["source"],
        action: "cut",
        observe: (listener) => {
          notify = listener;
          listener({ status: "preparing" });
          return () => {};
        },
      };
      presenter.accept(operation);
      return (state: HistoryCommandObservation<StructuralRemovalReceipt>) => notify(state);
    };
    return {
      detachView: () => releaseView(),
      attachView: () => {
        releaseView = presenter.attach();
      },
      admission,
      setHead: (value: number) => {
        headSeq = value;
        for (const listener of headListeners) listener();
      },
    };
  };
  const receipt: StructuralRemovalReceipt = {
    storeEpoch: "epoch",
    documentCommits: [
      {
        documentId: "document",
        generation: 1,
        baseHeadSeq: 1,
        headSeq: 2,
        updateId: "update",
        update: null,
        stateVector: new Uint8Array(),
      },
    ],
  };
  const pending = () =>
    nfmClipboardPastePendingPluginKey.getState(editor.prosemirrorState)!.removals;

  test("preserves content and waits for both exact head and source DOM after acknowledgement", async () => {
    const { admission, setHead } = await fixture();
    const before = editor.prosemirrorState.doc;
    let notify!: ReturnType<typeof admission>;
    await flush(() => {
      notify = admission("cut");
    });
    expect(editor.prosemirrorState.doc).toBe(before);
    expect(editor.domElement?.querySelector('[data-nfm-pending-removal="cut"]')).not.toBeNull();
    await flush(() => notify({ status: "committed", receipt, entryId: 1 }));
    await flush(() => editor.removeBlocks(["source"]));
    expect(pending()).toHaveLength(1);
    await flush(() => setHead(2));
    expect(pending()).toHaveLength(0);
  });

  test("canonical content before ACK and one failed overlapping operation preserve the other lease", async () => {
    const { admission, setHead } = await fixture();
    let first!: ReturnType<typeof admission>;
    let second!: ReturnType<typeof admission>;
    await flush(() => {
      first = admission("first");
      second = admission("second");
    });
    await flush(() => first({ status: "rejected", reason: "Conflict" }));
    expect(pending().map((marker) => marker.operationId)).toEqual(["second"]);
    await flush(() => {
      setHead(2);
      editor.removeBlocks(["source"]);
      second({ status: "recovering", reason: "Reply lost" });
    });
    expect(pending()).toHaveLength(1);
    await flush(() => second({ status: "committed", receipt, entryId: 2 }));
    expect(pending()).toHaveLength(0);
  });
  test("retains an admitted removal across a temporary view detachment", async () => {
    const { detachView, attachView, admission, setHead } = await fixture();
    let notify!: ReturnType<typeof admission>;
    await flush(() => {
      notify = admission("retained");
      detachView();
    });
    await flush(() => {
      setHead(2);
      editor.removeBlocks(["source"]);
      notify({ status: "committed", receipt, entryId: 1 });
    });
    expect(pending()).toHaveLength(1);
    await flush(attachView);
    expect(pending()).toHaveLength(0);
  });
});
