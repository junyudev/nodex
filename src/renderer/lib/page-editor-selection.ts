import { getNfmBlockSelectionIds } from "../components/board/editor/nfm-block-selection";
import type {
  SideMenuSelectionEditor,
  SideMenuSelectionBlock,
} from "../components/board/editor/nfm-side-menu-selection";

/** Never turn a caret into context. Selected descendants belong to their selected root. */
export function readPageEditorSelectedBlockIds(editor: SideMenuSelectionEditor): readonly string[] {
  const selection = editor.prosemirrorView?.state.selection;
  if (!selection || selection.empty) return [];
  const ids = getNfmBlockSelectionIds(selection);
  const blocks = editor.getSelection?.()?.blocks ?? [];
  const selected = new Set(
    ids.length ? ids : blocks.flatMap((block) => (block.id ? [block.id] : [])),
  );
  const descendants = new Set<string>();
  const visit = (block: SideMenuSelectionBlock, selectedAncestor: boolean) => {
    if (selectedAncestor && block.id) descendants.add(block.id);
    for (const child of block.children ?? [])
      visit(child, selectedAncestor || Boolean(block.id && selected.has(block.id)));
  };
  for (const block of blocks) visit(block, false);
  return [...selected].filter((id) => !descendants.has(id));
}

/** Blur preserves the logical selection so focusing the Composer cannot discard context. */
export function createPageEditorSelectionObservation(input: {
  readonly read: () => readonly string[];
  readonly focused: () => boolean;
}) {
  let snapshot: readonly string[] = [...input.read()];
  const listeners = new Set<() => void>();
  const publish = (next: readonly string[]) => {
    if (next.length === snapshot.length && next.every((id, index) => id === snapshot[index]))
      return;
    snapshot = [...next];
    for (const listener of listeners) listener();
  };
  return {
    readSelection: () => snapshot,
    subscribeSelection(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update() {
      const next = input.read();
      if (next.length === 0 && !input.focused()) return;
      publish(next);
    },
    /** Content handed to a chat leaves the Page's selection behind, wherever focus went. */
    release() {
      publish([]);
    },
  };
}
