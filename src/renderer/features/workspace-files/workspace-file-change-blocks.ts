import type { FileDiffMetadata } from "@pierre/diffs";

export interface WorkspaceFileChangedSection {
  readonly additionLineIndex: number;
  readonly deletionLineIndex: number;
  readonly additions: number;
  readonly deletions: number;
}

export function workspaceFileChangedSections(
  diff: Pick<FileDiffMetadata, "hunks">,
): readonly WorkspaceFileChangedSection[] {
  return diff.hunks.flatMap((hunk) => hunk.hunkContent.filter((block) => block.type === "change"));
}

export interface WorkspaceFileChangeNavigationState {
  readonly count: number;
  /** The change under the caret, or -1 between changes. */
  readonly activeIndex: number;
  readonly previousIndex: number;
  readonly nextIndex: number;
}

/** The navigator follows the caret and disables at either boundary; it does not wrap. */
export function workspaceFileChangeNavigation(
  sections: readonly WorkspaceFileChangedSection[],
  caretLineIndex: number,
  lineCount: number,
): WorkspaceFileChangeNavigationState {
  const lastLine = Math.max(0, lineCount - 1);
  const activeIndex = sections.findIndex(
    (section) =>
      caretLineIndex >= Math.min(section.additionLineIndex, lastLine) &&
      caretLineIndex <
        Math.min(section.additionLineIndex, lastLine) + Math.max(1, section.additions),
  );
  return {
    count: sections.length,
    activeIndex,
    previousIndex: sections.findLastIndex(
      (section, index) =>
        (activeIndex < 0 || index < activeIndex) && section.additionLineIndex < caretLineIndex,
    ),
    nextIndex: sections.findIndex(
      (section, index) => index > activeIndex && section.additionLineIndex > caretLineIndex,
    ),
  };
}
