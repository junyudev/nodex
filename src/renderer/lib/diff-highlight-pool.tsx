import { createHighlightPool } from "./highlight-pool";

const wordDiffHighlightPool = createHighlightPool({
  name: "word-diff-highlight",
  lineDiffType: "word-alt",
});
export const getWordDiffHighlightPool = wordDiffHighlightPool.getPool;
export const useWordDiffHighlightPoolState = wordDiffHighlightPool.usePoolState;
export const WordDiffHighlightPoolProvider = wordDiffHighlightPool.Provider;
