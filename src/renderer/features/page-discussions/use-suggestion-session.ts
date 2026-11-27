import { useCallback, useEffect, useRef, useState } from "react";
import { ForkYDocExtension } from "@blocknote/core/yjs";
import { TextSelection, type SelectionBookmark } from "@tiptap/pm/state";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import type { NfmDiscussionsEditor } from "@/components/board/editor/nfm-page-discussions-capability";
import {
  EMPTY_DISCUSSION_MARKS_PRESENTATION,
  NFM_SUGGEST_START_EVENT,
  nfmDiscussionMarksPluginKey,
  setNfmDiscussionMarksPresentation,
} from "@/components/board/editor/nfm-discussion-marks-extension";
import { writeMarkdown, type MarkdownBlock } from "../../../shared/nodex-markdown";
import { computeSuggestionHunks, type SuggestionHunk } from "./suggestion-hunks";

type EditorBlock = NfmDiscussionsEditor["document"][number];

const markdownOf = (blocks: readonly EditorBlock[]): string =>
  writeMarkdown(blocks as unknown as MarkdownBlock[]);

/** The browser may extend a text selection before ProseMirror receives selectionchange. */
function captureSuggestionSelection(editor: NfmDiscussionsEditor): SelectionBookmark {
  const { selection, doc } = editor.prosemirrorState;
  const view = editor.prosemirrorView;
  if (!view?.hasFocus() || !(selection instanceof TextSelection)) return selection.getBookmark();

  const native = view.dom.ownerDocument.getSelection();
  if (
    native?.rangeCount !== 1 ||
    !native.anchorNode ||
    !native.focusNode ||
    !view.dom.contains(native.anchorNode) ||
    !view.dom.contains(native.focusNode)
  ) {
    return selection.getBookmark();
  }
  const anchor = view.posAtDOM(native.anchorNode, native.anchorOffset, 1);
  const head = view.posAtDOM(native.focusNode, native.focusOffset, 1);
  return TextSelection.between(doc.resolve(anchor), doc.resolve(head)).getBookmark();
}

export interface SuggestionSession {
  /** Changed runs of Blocks so far; each becomes one Suggested edit. */
  readonly changeCount: number;
  readonly submitting: boolean;
}

/** Prepares one command whose identity and payload are reused after a failed attempt. */
type PrepareSubmission = (hunk: SuggestionHunk) => () => Promise<boolean>;

interface HunkAttempt {
  readonly send: () => Promise<boolean>;
  acknowledged: boolean;
}

interface SuggestionDraft {
  readonly base: readonly EditorBlock[];
  readonly attempts: Map<string, HunkAttempt>;
  submitting: boolean;
}

const hunkKey = (hunk: SuggestionHunk): string =>
  JSON.stringify([hunk.blockIds, hunk.oldMarkdown, hunk.newMarkdown]);

/**
 * A person's suggestion session. While suggesting, the Page is write-locked; the first attempt to
 * edit forks the document so the person edits a private copy with every editor feature. Submitting
 * turns each changed run of Blocks into a Suggested edit and returns the editor to the live Page;
 * discarding just returns it.
 */
export function useSuggestionSession({
  editor,
  suggesting,
  prepareSubmission,
}: {
  readonly editor: NfmDiscussionsEditor | null;
  readonly suggesting: boolean;
  readonly prepareSubmission: PrepareSubmission;
}): {
  readonly session: SuggestionSession | null;
  readonly submit: () => Promise<void>;
  readonly discard: () => boolean;
} {
  const [session, setSession] = useState<SuggestionSession | null>(null);
  const draftRef = useRef<SuggestionDraft | null>(null);

  useEffect(() => {
    const root = editor?.domElement;
    if (!editor || !root || !suggesting) return;
    const onStart = () => {
      if (draftRef.current) return;
      const fork = editor.getExtension(ForkYDocExtension);
      if (!fork) return;
      draftRef.current = { base: editor.document, attempts: new Map(), submitting: false };
      const selection = captureSuggestionSelection(editor);
      fork.fork();
      editor.transact((transaction) =>
        transaction.setSelection(selection.resolve(transaction.doc)),
      );
      // Lift the lock synchronously so the edit that started the session lands in the fork.
      setNfmDiscussionMarksPresentation(editor, {
        ...(nfmDiscussionMarksPluginKey.getState(editor.prosemirrorState)?.presentation ??
          EMPTY_DISCUSSION_MARKS_PRESENTATION),
        writeLocked: false,
      });
      setSession({ changeCount: 0, submitting: false });
    };
    root.addEventListener(NFM_SUGGEST_START_EVENT, onStart);
    return () => root.removeEventListener(NFM_SUGGEST_START_EVENT, onStart);
  }, [editor, suggesting]);

  const active = session !== null;
  useEffect(() => {
    if (!editor || !active) return;
    let frame = 0;
    const recount = () => {
      frame = 0;
      const draft = draftRef.current;
      if (!draft) return;
      const count = computeSuggestionHunks(draft.base, editor.document, markdownOf).length;
      setSession((current) =>
        current && current.changeCount !== count ? { ...current, changeCount: count } : current,
      );
    };
    frame = requestAnimationFrame(recount);
    const unsubscribe = editor.onChange(() => {
      if (!frame) frame = requestAnimationFrame(recount);
    });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe?.();
    };
  }, [active, editor]);

  const end = useCallback(() => {
    if (!editor || !draftRef.current) return;
    editor.getExtension(ForkYDocExtension)?.merge({ keepChanges: false });
    draftRef.current = null;
    setSession(null);
  }, [editor]);

  const discard = useCallback(() => {
    if (draftRef.current?.submitting) return false;
    end();
    return true;
  }, [end]);

  const submit = useCallback(async () => {
    const draft = draftRef.current;
    if (!editor || !draft || draft.submitting) return;
    const hunks = computeSuggestionHunks(draft.base, editor.document, markdownOf);
    draft.submitting = true;
    setSession((current) => current && { ...current, submitting: true });

    await runWithCleanup(
      async () => {
        for (const hunk of hunks) {
          const key = hunkKey(hunk);
          const attempt = draft.attempts.get(key) ?? {
            send: prepareSubmission(hunk),
            acknowledged: false,
          };
          draft.attempts.set(key, attempt);
          if (!attempt.acknowledged) attempt.acknowledged = await attempt.send();
          if (!attempt.acknowledged) return;
        }
        // Edits made while a request was in flight still belong to the draft.
        const latest = computeSuggestionHunks(draft.base, editor.document, markdownOf);
        if (latest.every((hunk) => draft.attempts.get(hunkKey(hunk))?.acknowledged)) end();
      },
      {
        cleanup: () => {
          if (draftRef.current !== draft) return;
          draft.submitting = false;
          setSession((current) => current && { ...current, submitting: false });
        },
      },
    );
  }, [editor, end, prepareSubmission]);

  return { session, submit, discard };
}
