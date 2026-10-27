import { describe, expect, test } from "vite-plus/test";
import {
  workspaceFileChangeNavigation,
  workspaceFileChangedSections,
  workspaceFileDiffFromContents,
} from "./workspace-file-change-blocks";

function compare(oldContent: string | null, newContent: string | null) {
  return workspaceFileDiffFromContents({ path: "file.txt", oldContent, newContent });
}

describe("workspace file change blocks", () => {
  test("counts change blocks, follows the caret and disables instead of wrapping", () => {
    const sections = workspaceFileChangedSections(compare("a\nb\nc\nd\ne\n", "A\nb\nc\nd\nE\n"));
    expect(sections).toHaveLength(2);
    expect(workspaceFileChangeNavigation(sections, 0, 5)).toEqual({
      count: 2,
      activeIndex: 0,
      previousIndex: -1,
      nextIndex: 1,
    });
    expect(workspaceFileChangeNavigation(sections, 2, 5)).toEqual({
      count: 2,
      activeIndex: -1,
      previousIndex: 0,
      nextIndex: 1,
    });
    expect(workspaceFileChangeNavigation(sections, 4, 5)).toEqual({
      count: 2,
      activeIndex: 1,
      previousIndex: 0,
      nextIndex: -1,
    });
    const deletion = workspaceFileChangedSections(compare("keep\ndrop\n", "keep\n"));
    expect(workspaceFileChangeNavigation(deletion, 0, 1).activeIndex).toBe(0);
  });
});
