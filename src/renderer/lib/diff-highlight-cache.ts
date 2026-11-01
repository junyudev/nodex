import type { FileDiffMetadata } from "@pierre/diffs";
import { getSourceContentDigest } from "./source-content-version";

/**
 * Diff ASTs contain line addresses as well as colors. Both texts, their line
 * boundaries, hunk layout and partial/full state must name the cached result;
 * patch object IDs alone cannot identify hydrated working-tree content.
 */
export function diffHighlightCacheKey(diff: FileDiffMetadata): string {
  const deletions = diff.deletionLines.join("");
  const additions = diff.additionLines.join("");
  const layout = JSON.stringify([
    diff.name,
    diff.prevName,
    diff.lang,
    diff.type,
    diff.isPartial,
    diff.hunks,
    diff.splitLineCount,
    diff.unifiedLineCount,
    diff.deletionLines.map((line) => line.length),
    diff.additionLines.map((line) => line.length),
  ]);
  return [
    deletions.length + additions.length,
    "diff",
    getSourceContentDigest(deletions),
    getSourceContentDigest(additions),
    getSourceContentDigest(layout),
  ].join("\0");
}

/** Count actual arrays, including expanded context, rather than patch-only totals. */
export function diffHighlightTextLength(diff: FileDiffMetadata): number {
  return (
    diff.deletionLines.reduce((sum, line) => sum + line.length, 0) +
    diff.additionLines.reduce((sum, line) => sum + line.length, 0)
  );
}
