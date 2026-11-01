import type { FileDiffMetadata } from "@pierre/diffs/react";
import { diffHighlightCacheKey } from "@/lib/diff-highlight-cache";

const REVIEW_IGNORABLE_WHITESPACE = /[ \t\r\n\f\v]/g;

interface ExpandPartialDiffMetadataOptions {
  ignoreWhitespace?: boolean;
}

interface ExpandedHunkLayout {
  hunks: FileDiffMetadata["hunks"];
  splitLineCount: number;
  unifiedLineCount: number;
}

function areReviewLinesEqual(left: string, right: string, ignoreWhitespace: boolean): boolean {
  if (!ignoreWhitespace) return left === right;
  return (
    left.replace(REVIEW_IGNORABLE_WHITESPACE, "") === right.replace(REVIEW_IGNORABLE_WHITESPACE, "")
  );
}

function areReviewLineRangesEqual(
  left: readonly string[],
  right: readonly string[],
  leftStart: number,
  rightStart: number,
  count: number,
  ignoreWhitespace: boolean,
): boolean {
  for (let offset = 0; offset < count; offset += 1) {
    const leftLine = left[leftStart + offset];
    const rightLine = right[rightStart + offset];
    if (leftLine === undefined || rightLine === undefined) return false;
    if (!areReviewLinesEqual(leftLine, rightLine, ignoreWhitespace)) {
      return false;
    }
  }

  return true;
}

function expandReviewHunkLayout(
  metadata: FileDiffMetadata,
  deletionLines: readonly string[],
  additionLines: readonly string[],
  ignoreWhitespace: boolean,
): ExpandedHunkLayout | null {
  const expandedHunks: FileDiffMetadata["hunks"] = [];
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  let previousAdditionEnd = 0;
  let previousDeletionEnd = 0;

  for (const hunk of metadata.hunks) {
    const additionStartIndex = Math.max(hunk.additionStart - 1, 0);
    const deletionStartIndex = Math.max(hunk.deletionStart - 1, 0);
    const additionGap = additionStartIndex - previousAdditionEnd;
    const deletionGap = deletionStartIndex - previousDeletionEnd;

    if (additionGap < 0 || deletionGap < 0) return null;
    if (additionGap !== deletionGap) return null;
    if (additionStartIndex + hunk.additionCount > additionLines.length) {
      return null;
    }
    if (deletionStartIndex + hunk.deletionCount > deletionLines.length) {
      return null;
    }
    if (
      !areReviewLineRangesEqual(
        deletionLines,
        additionLines,
        previousDeletionEnd,
        previousAdditionEnd,
        additionGap,
        ignoreWhitespace,
      )
    ) {
      return null;
    }

    let additionLineIndex = additionStartIndex;
    let deletionLineIndex = deletionStartIndex;
    const hunkContent: FileDiffMetadata["hunks"][number]["hunkContent"] = [];

    for (const content of hunk.hunkContent) {
      const additions = content.type === "context" ? content.lines : content.additions;
      const deletions = content.type === "context" ? content.lines : content.deletions;

      if (
        !areReviewLineRangesEqual(
          metadata.deletionLines,
          deletionLines,
          content.deletionLineIndex,
          deletionLineIndex,
          deletions,
          ignoreWhitespace,
        )
      ) {
        return null;
      }
      if (
        !areReviewLineRangesEqual(
          metadata.additionLines,
          additionLines,
          content.additionLineIndex,
          additionLineIndex,
          additions,
          ignoreWhitespace,
        )
      ) {
        return null;
      }

      hunkContent.push({
        ...content,
        additionLineIndex,
        deletionLineIndex,
      });
      additionLineIndex += additions;
      deletionLineIndex += deletions;
    }

    expandedHunks.push({
      ...hunk,
      collapsedBefore: additionGap,
      additionLineIndex: additionStartIndex,
      deletionLineIndex: deletionStartIndex,
      hunkContent,
      splitLineStart: splitLineCount + additionGap,
      unifiedLineStart: unifiedLineCount + additionGap,
    });
    splitLineCount += additionGap + hunk.splitLineCount;
    unifiedLineCount += additionGap + hunk.unifiedLineCount;
    previousAdditionEnd = additionStartIndex + hunk.additionCount;
    previousDeletionEnd = deletionStartIndex + hunk.deletionCount;
  }

  if (expandedHunks.length > 0) {
    const trailingAdditions = additionLines.length - previousAdditionEnd;
    const trailingDeletions = deletionLines.length - previousDeletionEnd;
    if (trailingAdditions < 0 || trailingDeletions < 0) return null;
    if (trailingAdditions !== trailingDeletions) return null;
    if (
      !areReviewLineRangesEqual(
        deletionLines,
        additionLines,
        previousDeletionEnd,
        previousAdditionEnd,
        trailingAdditions,
        ignoreWhitespace,
      )
    ) {
      return null;
    }
    splitLineCount += trailingAdditions;
    unifiedLineCount += trailingAdditions;
  }

  return {
    hunks: expandedHunks,
    splitLineCount,
    unifiedLineCount,
  };
}
export function expandPartialDiffMetadata(
  metadata: FileDiffMetadata,
  deletionLines: readonly string[],
  additionLines: readonly string[],
  options: ExpandPartialDiffMetadataOptions = {},
): FileDiffMetadata | null {
  const layout = expandReviewHunkLayout(
    metadata,
    deletionLines,
    additionLines,
    options.ignoreWhitespace === true,
  );
  if (!layout) return null;

  const expanded: FileDiffMetadata = {
    ...metadata,
    ...layout,
    isPartial: false,
    deletionLines: [...deletionLines],
    additionLines: [...additionLines],
    deletionCharacterCount: deletionLines.reduce((sum, line) => sum + line.length, 0),
    additionCharacterCount: additionLines.reduce((sum, line) => sum + line.length, 0),
  };
  return { ...expanded, cacheKey: diffHighlightCacheKey(expanded) };
}
