import { useBlockNoteEditor } from "@blocknote/react";
import { useEffect, useMemo, type ReactNode } from "react";
import { NfmPageAskProvider } from "./nfm-page-ask";
import { NFM_DISCUSSION_COMMENT_EVENT } from "./nfm-discussion-marks-extension";
import {
  NfmPageDiscussionsCapabilityContext,
  type NfmDiscussionsEditor,
  type NfmPageDiscussionsBinding,
} from "./nfm-page-discussions-capability";

const NO_ASK = () => {};

/**
 * Connects one mounted Page editor to its Discussions owner: hands over the editor, offers the
 * Discussion actions to the selection menu, owns the in-place Ask composer, and renders the
 * owner's overlay (such as the new-Comment composer) inside the editor.
 */
export function NfmPageDiscussionsBridge({
  binding,
  overlay,
  children,
}: {
  readonly binding: NfmPageDiscussionsBinding | null;
  readonly overlay?: ReactNode;
  readonly children: ReactNode;
}) {
  const editor = useBlockNoteEditor() as unknown as NfmDiscussionsEditor;
  const attachEditor = binding?.attachEditor;
  const start = binding?.start;
  const submitAsk = binding?.submitAsk ?? null;
  useEffect(() => {
    if (!attachEditor) return;
    attachEditor(editor);
    return () => attachEditor(null);
  }, [attachEditor, editor]);
  useEffect(() => {
    const root = editor.domElement;
    if (!root || !start) return;
    const onComment = () => start("comment");
    root.addEventListener(NFM_DISCUSSION_COMMENT_EVENT, onComment);
    return () => root.removeEventListener(NFM_DISCUSSION_COMMENT_EVENT, onComment);
  }, [editor, start]);
  const capability = useMemo(() => (start ? { start } : null), [start]);
  if (!binding) return children;
  return (
    <NfmPageDiscussionsCapabilityContext value={capability}>
      <NfmPageAskProvider enabled={submitAsk !== null} onSubmit={submitAsk ?? NO_ASK}>
        {children}
        {overlay}
      </NfmPageAskProvider>
    </NfmPageDiscussionsCapabilityContext>
  );
}
