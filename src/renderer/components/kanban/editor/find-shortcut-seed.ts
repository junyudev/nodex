interface ProsemirrorSelectionLike {
  empty: boolean;
  from: number;
  to: number;
}

interface ProsemirrorDocLike {
  textBetween: (from: number, to: number, blockSeparator?: string) => string;
}

interface ProsemirrorStateLike {
  selection?: ProsemirrorSelectionLike;
  doc?: ProsemirrorDocLike;
}

interface EditorWithSelectionLike {
  prosemirrorState?: ProsemirrorStateLike;
}

export function resolveFindShortcutSeedQuery(editor: EditorWithSelectionLike | null | undefined): string {
  const prosemirrorState = editor?.prosemirrorState;
  if (!prosemirrorState?.selection || !prosemirrorState.doc) return "";

  const selection = prosemirrorState.selection;
  if (selection.empty) return "";

  return prosemirrorState.doc.textBetween(selection.from, selection.to, " ").trim();
}
