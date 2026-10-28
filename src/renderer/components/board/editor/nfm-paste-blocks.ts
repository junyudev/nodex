import type { BlockNoteEditor } from "@blocknote/core";
import type { MarkdownBlock } from "../../../../shared/nodex-markdown";
import { markdownBlocksForEditor } from "../../../../shared/nodex-markdown/blocknote";

export type NfmBlocksPasteEditor = Pick<
  BlockNoteEditor<any, any, any>,
  "blocksToFullHTML" | "pasteHTML"
>;

/**
 * Pastes Blocks read from text where the paste goes. Their text is exact, so it keeps the spaces
 * and tabs that pasted HTML would otherwise collapse.
 */
export function pasteNfmBlocks(
  editor: NfmBlocksPasteEditor,
  blocks: readonly MarkdownBlock[],
): boolean {
  if (blocks.length === 0) return false;
  const html = editor.blocksToFullHTML(
    markdownBlocksForEditor(blocks) as Parameters<NfmBlocksPasteEditor["blocksToFullHTML"]>[0],
  );
  editor.pasteHTML(`<div style="white-space: pre-wrap">${html}</div>`, true);
  return true;
}
