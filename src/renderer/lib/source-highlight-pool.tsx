import {
  DEFAULT_TOKENIZE_MAX_LENGTH,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { createHighlightPool, type HighlightPoolState } from "./highlight-pool";

/** Source/comparison colors and their cache live as long as the renderer. */
const sourceHighlightPool = createHighlightPool({ name: "source-highlight", lineDiffType: "none" });
export const getSourceHighlightPool = sourceHighlightPool.getPool;
export const useSourceHighlightPoolState = sourceHighlightPool.usePoolState;
export const SourceHighlightPoolProvider = sourceHighlightPool.Provider;
export type SourceHighlightPoolState = HighlightPoolState;

/**
 * Resolves once the pool holds the highlight for this content, so an editor can
 * start from it. Resolves immediately when nothing will be highlighted (plain
 * text, or more lines than Pierre tokenizes) or the result is already cached, and
 * rejects when the pool cannot highlight it.
 */
export function primeSourceHighlight(
  pool: WorkerPoolManager,
  item: { readonly file: FileContents } | { readonly fileDiff: FileDiffMetadata },
): Promise<void> {
  if ("file" in item) {
    if (countLines(item.file.contents) > DEFAULT_TOKENIZE_MAX_LENGTH) return Promise.resolve();
    return pool.primeFileHighlightCache(item.file);
  }
  const { additionLines, deletionLines } = item.fileDiff;
  if (Math.max(additionLines.length, deletionLines.length) > DEFAULT_TOKENIZE_MAX_LENGTH) {
    return Promise.resolve();
  }
  return pool.primeDiffHighlightCache(item.fileDiff);
}

function countLines(contents: string): number {
  let lines = 1;
  for (
    let index = contents.indexOf("\n");
    index !== -1;
    index = contents.indexOf("\n", index + 1)
  ) {
    lines += 1;
  }
  return lines;
}
