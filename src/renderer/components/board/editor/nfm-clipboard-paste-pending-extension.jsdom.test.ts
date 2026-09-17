import { BlockNoteEditor } from "@blocknote/core";
import { afterEach, describe, expect, test } from "vite-plus/test";

import {
  nfmClipboardPastePendingExtension,
  nfmClipboardPastePendingPluginKey,
  setNfmClipboardPastePending,
  setNfmIncomingPageTransfers,
  setNfmPendingRemovals,
} from "./nfm-clipboard-paste-pending-extension";

describe("NFM clipboard paste pending extension", () => {
  let editor: BlockNoteEditor | null = null;

  afterEach(() => {
    editor?._tiptapEditor.destroy();
    editor = null;
  });

  test("tracks a stable Block without writing placeholder content or Undo state", () => {
    editor = BlockNoteEditor.create({
      initialContent: [{ id: "paste-anchor", type: "paragraph", content: "Target" }],
      extensions: [nfmClipboardPastePendingExtension()],
    });
    editor.mount(document.createElement("div"));

    setNfmClipboardPastePending(editor, "paste-anchor", true);

    const pending = nfmClipboardPastePendingPluginKey.getState(editor.prosemirrorState);
    expect(pending?.blockIds.has("paste-anchor")).toBe(true);
    expect(pending?.decorations.find()).toHaveLength(1);
    expect(editor.getBlock("paste-anchor")?.content).toEqual([
      expect.objectContaining({ type: "text", text: "Target" }),
    ]);

    editor.removeBlocks(["paste-anchor"]);

    const removed = nfmClipboardPastePendingPluginKey.getState(editor.prosemirrorState);
    expect(removed?.blockIds.has("paste-anchor")).toBe(false);
    expect(removed?.decorations.find()).toHaveLength(0);
  });

  test("projects predictable structural moves as final-looking local semantics", () => {
    editor = BlockNoteEditor.create({
      initialContent: [{ id: "source", type: "paragraph", content: "Source" }],
      extensions: [nfmClipboardPastePendingExtension()],
    });
    const container = document.createElement("div");
    editor.mount(container);
    const before = editor.prosemirrorState.doc;

    setNfmPendingRemovals(editor, [
      { operationId: "move-out", rootBlockIds: ["source"], action: "move" },
    ]);
    setNfmIncomingPageTransfers(editor, [
      {
        operationId: "move-in",
        pages: [{ pageId: "page", title: "Predicted Page" }],
        target: { parentBlockId: null, beforeBlockId: null },
      },
    ]);

    const removed = container.querySelector<HTMLElement>('[data-nfm-predicted-removal="move-out"]');
    expect(removed?.classList.contains("hidden")).toBe(true);
    expect(container.querySelector('[data-nfm-pending-removal="move-out"]')).toBeNull();
    expect(container.querySelector('[data-nfm-predicted-page="page"]')?.textContent).toContain(
      "Predicted Page",
    );
    expect(editor.prosemirrorState.doc).toBe(before);
  });
});
