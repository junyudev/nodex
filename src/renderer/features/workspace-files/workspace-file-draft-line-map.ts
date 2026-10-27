import { diffLines } from "diff";

const MAX_CONTENT_LENGTH = 262_144;
const MAX_EDIT_LENGTH = 512;

export interface WorkspaceFileDraftLineRange {
  readonly draftStart: number;
  readonly savedStart: number;
  readonly lineCount: number;
}

/** One-based unchanged ranges only. An unavailable bounded diff never guesses authorship. */
export function buildWorkspaceFileDraftLineMap(
  savedContent: string,
  draftContent: string,
): readonly WorkspaceFileDraftLineRange[] | null {
  if (savedContent.length > MAX_CONTENT_LENGTH || draftContent.length > MAX_CONTENT_LENGTH) {
    return null;
  }
  if (savedContent === draftContent) {
    return [{ draftStart: 1, savedStart: 1, lineCount: draftContent.split("\n").length }];
  }
  const changes = diffLines(savedContent, draftContent, { maxEditLength: MAX_EDIT_LENGTH });
  if (!changes) return null;

  const ranges: WorkspaceFileDraftLineRange[] = [];
  let draftStart = 1;
  let savedStart = 1;
  for (const change of changes) {
    if (change.added) {
      draftStart += change.count;
      continue;
    }
    if (change.removed) {
      savedStart += change.count;
      continue;
    }
    ranges.push({ draftStart, savedStart, lineCount: change.count });
    draftStart += change.count;
    savedStart += change.count;
  }
  return ranges;
}

export function workspaceFileSavedLineNumber(
  ranges: readonly WorkspaceFileDraftLineRange[] | null,
  draftLineNumber: number,
): number | null {
  if (!Number.isInteger(draftLineNumber) || draftLineNumber < 1) return null;
  const range = ranges?.find(
    (range) =>
      draftLineNumber >= range.draftStart && draftLineNumber < range.draftStart + range.lineCount,
  );
  return range ? range.savedStart + draftLineNumber - range.draftStart : null;
}
