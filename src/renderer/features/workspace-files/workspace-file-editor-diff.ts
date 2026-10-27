import type { FileDiffMetadata } from "@pierre/diffs";
import { workspaceFileDiffFromContents } from "./workspace-file-change-blocks";

/** Pierre needs a context region to mount a zero-change diff as an editable document. */
export function workspaceFileEditorDiffFromContents(
  input: Parameters<typeof workspaceFileDiffFromContents>[0] & {
    readonly oldContent: string;
    readonly newContent: string;
  },
): FileDiffMetadata {
  const diff = workspaceFileDiffFromContents(input);
  if (diff.hunks.length > 0) return diff;

  const lines = diff.additionLines.length ? diff.additionLines : [""];
  const lineCount = lines.length;
  const noEOFCR = !lines.at(-1)?.endsWith("\n");
  return {
    ...diff,
    additionLines: lines,
    deletionLines: [...lines],
    splitLineCount: lineCount,
    unifiedLineCount: lineCount,
    hunks: [
      {
        collapsedBefore: 0,
        additionStart: 1,
        additionCount: lineCount,
        additionLines: 0,
        additionLineIndex: 0,
        deletionStart: 1,
        deletionCount: lineCount,
        deletionLines: 0,
        deletionLineIndex: 0,
        splitLineStart: 0,
        splitLineCount: lineCount,
        unifiedLineStart: 0,
        unifiedLineCount: lineCount,
        noEOFCRAdditions: noEOFCR,
        noEOFCRDeletions: noEOFCR,
        hunkContent: [
          { type: "context", lines: lineCount, additionLineIndex: 0, deletionLineIndex: 0 },
        ],
      },
    ],
  };
}
