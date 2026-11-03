import { BlockNoteEditor } from "@blocknote/core";
import { act, StrictMode, useLayoutEffect } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { createNfmEditorExtensions } from "./nfm-editor-extensions";
import { goToNextNfmSearchMatch, setNfmSearchQuery } from "./search-extension";
import { useNfmSearchState } from "./use-nfm-search-state";

function SearchProbe({ editor, onCommit }: { editor: BlockNoteEditor; onCommit: () => void }) {
  const state = useNfmSearchState(editor);
  useLayoutEffect(onCommit);
  return (
    <output aria-label="Search matches">
      {state.totalMatches}:{state.activeIndex}
    </output>
  );
}

describe("editor search observations", () => {
  test("observes query-only and navigation transactions without changing editor content", async () => {
    const editor = BlockNoteEditor.create({
      extensions: createNfmEditorExtensions(),
      initialContent: [{ type: "paragraph", content: "alpha beta alpha" }],
    });
    const editorHost = document.createElement("div");
    document.body.appendChild(editorHost);
    editor.mount(editorHost);
    const before = editor.prosemirrorState.doc;
    const onCommit = vi.fn();
    const view = render(
      <StrictMode>
        <SearchProbe editor={editor} onCommit={onCommit} />
      </StrictMode>,
    );
    try {
      await act(async () => {
        setNfmSearchQuery(editor, "alpha");
      });
      expect(view.getByLabelText("Search matches").textContent).toBe("2:-1");
      await act(async () => {
        goToNextNfmSearchMatch(editor);
      });
      expect(view.getByLabelText("Search matches").textContent).toBe("2:0");
      await act(async () => {
        setNfmSearchQuery(editor, "missing");
      });
      expect(view.getByLabelText("Search matches").textContent).toBe("0:-1");
      expect(editor.prosemirrorState.doc).toBe(before);
      const observedCommits = onCommit.mock.calls.length;
      await act(async () => {
        editor.transact((tr) => {
          tr.setMeta("unrelated", true);
        });
      });
      expect(onCommit).toHaveBeenCalledTimes(observedCommits);
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
      editorHost.remove();
    }
  });
});
