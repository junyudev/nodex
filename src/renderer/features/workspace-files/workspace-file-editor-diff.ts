import { processFile, type FileDiffMetadata } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";

/** Either side longer than this is not compared; diffing it would stall the window. */
export const WORKSPACE_FILE_COMPARISON_MAX_CHARACTERS = 2 * 1024 * 1024;
/** Line diffing that runs longer than this gives up instead of blocking the window. */
export const WORKSPACE_FILE_COMPARISON_TIMEOUT_MS = 25;

/** Why a comparison was not computed; the editor then shows the plain file. */
export type WorkspaceFileComparisonLimit = "too-large" | "too-complex";

/** A comparison the editor can show, or why it shows the plain file instead. */
export type WorkspaceFileComparison =
  | { readonly status: "ready"; readonly diff: FileDiffMetadata }
  | { readonly status: WorkspaceFileComparisonLimit };

/**
 * Compares a file with its base text within bounded window-thread work. A ready
 * comparison always mounts as an editable document, including when nothing changed.
 */
export function compareWorkspaceFileContents(
  input: {
    readonly path: string;
    readonly oldPath?: string;
    readonly oldContent: string;
    readonly newContent: string;
  },
  timeoutMs = WORKSPACE_FILE_COMPARISON_TIMEOUT_MS,
): WorkspaceFileComparison {
  const { oldContent, newContent } = input;
  if (
    oldContent.length > WORKSPACE_FILE_COMPARISON_MAX_CHARACTERS ||
    newContent.length > WORKSPACE_FILE_COMPARISON_MAX_CHARACTERS
  ) {
    return { status: "too-large" };
  }
  const oldFile = { name: input.oldPath ?? input.path, contents: oldContent };
  const newFile = { name: input.path, contents: newContent };
  const patch = createTwoFilesPatch(
    oldFile.name,
    newFile.name,
    oldContent,
    newContent,
    undefined,
    undefined,
    { timeout: timeoutMs },
  );
  const diff = patch === undefined ? undefined : processFile(patch, { oldFile, newFile });
  if (!diff) return { status: "too-complex" };
  return { status: "ready", diff: withMountableContext(diff) };
}

/** Pierre needs a context region to mount a zero-change diff as an editable document. */
function withMountableContext(diff: FileDiffMetadata): FileDiffMetadata {
  if (diff.hunks.length > 0) return diff;

  const lines = diff.additionLines.length ? diff.additionLines : [""];
  const lineCount = lines.length;
  // An empty file has no final line to terminate, so it reports no missing newline.
  const lastLine = lines.at(-1) ?? "";
  const noEOFCR = lastLine !== "" && !lastLine.endsWith("\n");
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
