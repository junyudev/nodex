import { TextSelection, type Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** Read the browser's selection even when ProseMirror has not processed selectionchange yet. */
export function readComposerEditorSelection(view: EditorView): Selection | null {
  const selection = view.dom.ownerDocument.getSelection();
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !view.dom.contains(selection.anchorNode) ||
    !view.dom.contains(selection.focusNode)
  )
    return null;

  const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
  const head = view.posAtDOM(selection.focusNode, selection.focusOffset);
  const { doc } = view.state;
  if (Math.min(anchor, head) < 0 || Math.max(anchor, head) > doc.content.size) return null;

  return TextSelection.between(doc.resolve(anchor), doc.resolve(head));
}
