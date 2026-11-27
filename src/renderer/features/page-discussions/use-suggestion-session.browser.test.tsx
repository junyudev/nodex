import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { TextSelection } from "@tiptap/pm/state";
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import {
  EMPTY_DISCUSSION_MARKS_PRESENTATION,
  NFM_SUGGEST_START_EVENT,
  nfmDiscussionMarksExtension,
  setNfmDiscussionMarksPresentation,
} from "@/components/board/editor/nfm-discussion-marks-extension";
import { nfmSchema } from "@/components/board/editor/nfm-schema";
import { createPageDocumentGenesis } from "../../../shared/block-documents/block-document-codec";
import type { SuggestionHunk } from "./suggestion-hunks";
import { useSuggestionSession } from "./use-suggestion-session";

test("starts suggesting with the complete visible selection", async () => {
  const original = "Review how people move between entry points.";
  const replacement = "channels in December.";
  const expected = "Review how people move between channels in December.";
  const blockId = "block:review";
  const { document: canonical } = createPageDocumentGenesis({
    documentId: "document:review",
    title: "Review",
    markdown: original,
    allocateBlockId: () => blockId,
  });
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: nfmSchema,
      extensions: [nfmDiscussionMarksExtension()],
      collaboration: { fragment: canonical.getXmlFragment("body") },
    }),
  );
  const host = document.body.appendChild(document.createElement("div"));
  editor.mount(host);
  const submitted: SuggestionHunk[] = [];
  const suggestion = renderHook(() =>
    useSuggestionSession({
      editor,
      suggesting: true,
      prepareSubmission: (hunk) => async () => {
        submitted.push(hunk);
        return true;
      },
    }),
  );
  try {
    const view = editor.prosemirrorView;
    const text = view?.dom.querySelector("p")?.firstChild;
    const native = document.getSelection();
    if (!view || !(text instanceof Text) || !native) throw new Error("Missing editor text");
    const from = original.indexOf("entry points.");
    const to = original.length;
    await act(async () => {
      editor.focus();
      setNfmDiscussionMarksPresentation(editor, {
        ...EMPTY_DISCUSSION_MARKS_PRESENTATION,
        writeLocked: true,
      });
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(
            view.state.doc,
            view.posAtDOM(text, from),
            view.posAtDOM(text, to - 3),
          ),
        ),
      );
      // Chromium can advance the visible selection before ProseMirror receives selectionchange.
      native.setBaseAndExtent(text, from, text, to);
      view.dom.dispatchEvent(new CustomEvent(NFM_SUGGEST_START_EVENT, { bubbles: true }));
      editor.transact((transaction) => transaction.insertText(replacement));
    });

    expect(view.state.doc.textContent).toBe(expected);
    await act(async () => {
      view.dom.blur();
      await suggestion.result.current.submit();
    });
    expect(submitted).toEqual([
      { blockIds: [blockId], oldMarkdown: original, newMarkdown: expected },
    ]);
    expect(view.state.doc.textContent).toBe(original);
  } finally {
    suggestion.unmount();
    editor._tiptapEditor.destroy();
    canonical.destroy();
    host.remove();
  }
});

test("keeps the draft after a lost reply and retries only the unacknowledged edit", async () => {
  const first = "block:first";
  const last = "block:last";
  const ids = [first, "block:middle", last];
  const { document: canonical } = createPageDocumentGenesis({
    documentId: "document:retry",
    title: "Retry",
    markdown: "First\n\nMiddle\n\nLast",
    allocateBlockId: () => ids.shift()!,
  });
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: nfmSchema,
      extensions: [nfmDiscussionMarksExtension()],
      collaboration: { fragment: canonical.getXmlFragment("body") },
    }),
  );
  const host = document.body.appendChild(document.createElement("div"));
  editor.mount(host);
  const persisted = new Map<symbol, SuggestionHunk>();
  const sent: string[] = [];
  const suggestion = renderHook(() =>
    useSuggestionSession({
      editor,
      suggesting: true,
      prepareSubmission: (hunk) => {
        const identity = Symbol();
        return async () => {
          sent.push(hunk.blockIds[0]!);
          const duplicate = persisted.has(identity);
          persisted.set(identity, hunk);
          // The second edit reaches Core, but the first response is lost.
          return hunk.blockIds[0] !== last || duplicate;
        };
      },
    }),
  );
  try {
    await act(async () => {
      editor.domElement!.dispatchEvent(new CustomEvent(NFM_SUGGEST_START_EVENT));
      editor.updateBlock(first, { content: "Revised first" });
      editor.updateBlock(last, { content: "Revised last" });
    });
    await act(async () => suggestion.result.current.submit());
    expect(suggestion.result.current.session?.submitting).toBe(false);
    expect(editor.prosemirrorState.doc.textContent).toBe("Revised firstMiddleRevised last");
    expect(sent).toEqual([first, last]);

    await act(async () => suggestion.result.current.submit());
    expect(sent).toEqual([first, last, last]);
    expect([...persisted.values()]).toEqual([
      { blockIds: [first], oldMarkdown: "First", newMarkdown: "Revised first" },
      { blockIds: [last], oldMarkdown: "Last", newMarkdown: "Revised last" },
    ]);
    expect(suggestion.result.current.session).toBeNull();
    expect(editor.prosemirrorState.doc.textContent).toBe("FirstMiddleLast");
  } finally {
    suggestion.unmount();
    editor._tiptapEditor.destroy();
    canonical.destroy();
    host.remove();
  }
});
