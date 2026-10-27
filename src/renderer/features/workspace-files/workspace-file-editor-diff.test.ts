import { describe, expect, test } from "vite-plus/test";
import { workspaceFileChangedSections } from "./workspace-file-change-blocks";
import { workspaceFileEditorDiffFromContents } from "./workspace-file-editor-diff";

describe("editable diff documents", () => {
  test.each([
    { content: "", missingFinalNewline: false },
    { content: "first\nsecond", missingFinalNewline: true },
    { content: "first\r\nsecond\r\n", missingFinalNewline: false },
  ])("keeps unchanged text mountable: $content", ({ content, missingFinalNewline }) => {
    const diff = workspaceFileEditorDiffFromContents({
      path: "example.txt",
      oldContent: content,
      newContent: content,
    });
    expect(diff.hunks).toHaveLength(1);
    expect(diff.additionLines.join("")).toBe(content);
    expect(diff.deletionLines.join("")).toBe(content);
    expect(diff.unifiedLineCount).toBeGreaterThan(0);
    expect(workspaceFileChangedSections(diff)).toEqual([]);
    expect(diff.hunks[0]).toMatchObject({
      noEOFCRAdditions: missingFinalNewline,
      noEOFCRDeletions: missingFinalNewline,
    });
  });

  test("retains canonical changed blocks and rename paths", () => {
    const diff = workspaceFileEditorDiffFromContents({
      path: "new.txt",
      oldPath: "old.txt",
      oldContent: "a\nb\nc",
      newContent: "a\nnew\nc",
    });
    expect(diff.name).toBe("new.txt");
    expect(diff.prevName).toBe("old.txt");
    expect(workspaceFileChangedSections(diff)).toEqual([
      { type: "change", additions: 1, deletions: 1, additionLineIndex: 1, deletionLineIndex: 1 },
    ]);
  });
});
