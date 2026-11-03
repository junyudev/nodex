import { ShowSelectionExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor } from "@blocknote/react";
import { useLayoutEffect } from "react";

import { SelectedBlockDecorationsExtension } from "./selected-block-decorations";

export type NfmRetainedSelectionPresentation = "none" | "inline" | "blocks";

/** Keeps a menu-owned selection visible through the presentation matching its command scope. */
export function useNfmRetainedSelectionPresentation(
  presentation: NfmRetainedSelectionPresentation,
  owner: string,
  selectedBlockIds: readonly string[],
) {
  const editor = useBlockNoteEditor();
  const showSelection = editor.getExtension(ShowSelectionExtension)?.showSelection;
  const showSelectionAsBlocks = editor.getExtension(
    SelectedBlockDecorationsExtension,
  )?.showSelectionAsBlocks;
  const selectedBlockIdsSignature = JSON.stringify(selectedBlockIds);
  useLayoutEffect(() => {
    const blockIds: string[] = JSON.parse(selectedBlockIdsSignature);
    showSelection?.(presentation === "inline", owner);
    showSelectionAsBlocks?.(presentation === "blocks", owner, blockIds);
    return () => {
      showSelection?.(false, owner);
      showSelectionAsBlocks?.(false, owner);
    };
  }, [owner, presentation, selectedBlockIdsSignature, showSelection, showSelectionAsBlocks]);
}
