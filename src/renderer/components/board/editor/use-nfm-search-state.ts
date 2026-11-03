import { useCallback, useSyncExternalStore } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { getNfmSearchState } from "./search-extension";

/** Query-only transactions update the counters; unrelated cursor transactions do not rerender them. */
export function useNfmSearchState(
  editor: Pick<BlockNoteEditor<any, any, any>, "_tiptapEditor" | "prosemirrorState">,
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      editor._tiptapEditor.on("transaction", listener);
      return () => {
        editor._tiptapEditor.off("transaction", listener);
      };
    },
    [editor],
  );
  const read = useCallback(() => {
    const state = getNfmSearchState(editor);
    return `${state.totalMatches}:${state.activeIndex}`;
  }, [editor]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const [totalMatches, activeIndex] = snapshot.split(":").map(Number);
  return { totalMatches: totalMatches!, activeIndex: activeIndex! };
}
